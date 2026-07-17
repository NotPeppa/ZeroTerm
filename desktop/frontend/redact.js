// ZeroTerm 终端内容本地脱敏(发送给 AI 前执行)。
//
// 设计原则:
// 1. 分层匹配,置信度从高到低:
//    A. 已知格式凭据(厂商 token 前缀、JWT、PEM 私钥块)—— 格式即证据,无条件替换
//    B. 协议/语法位置(URL 内嵌密码、Authorization/Cookie 头)—— 位置即语义
//    C. 键名驱动(password=xxx、token: xxx 等)—— 键名说明值是敏感的
//    D. 网络/设备标识(公网 IP、MAC、UUID、主机提示符)—— 隐私而非凭据
//    E. 高熵兜底(长混合随机串)—— 低置信,规则从严,宁漏勿误
// 2. 幂等:同一文本重复脱敏输出不变。消息历史在每次请求前都会整体再过一遍
//    (redactAiMessagesForRequest),不幂等会破坏已有占位符。
// 3. 兜底规则误报的代价是 AI 看不懂终端内容,所以 E 类必须同时满足多个信号;
//    时间戳(20260607_134258)、git SHA、校验和、环境变量名、驼峰标识符等
//    常见终端内容一律放行。
//
// 该文件同时以浏览器全局脚本(globalThis.ZeroTermRedact)和 Node CJS 模块
// (供 desktop/tests/redact.test.js)两种方式加载,不依赖 DOM/Tauri。

(function (global) {
  "use strict";

  // 占位符形如 [REDACTED_XXX];任何规则碰到已有占位符必须原样保留(幂等)
  const PLACEHOLDER_RE = /REDACTED_[A-Z0-9_]+/;

  // ---------- 白名单判定 ----------

  function isPureDigits(value) {
    return /^\d+$/.test(value);
  }

  // git SHA、sha256/md5 校验和、docker 摘要等;十六进制串是终端里最常见的
  // 合法长串。纯 hex 形态的真实密钥只能靠 C 类键名规则兜住。
  function isPureHex(value) {
    return /^(?:0x)?[0-9a-f]+$/i.test(value);
  }

  // 数字分段:20260607_134258、2026-06-07、2026_06_07_13_42_58 等日期/时间戳
  function isDigitGroups(value) {
    return /^\d{1,8}(?:[-_.]\d{1,8})+$/.test(value);
  }

  // SSH 公钥 blob(authorized_keys / known_hosts 输出)。公钥不是秘密,
  // 保留它 AI 才能帮用户排查登录问题;私钥由 PEM 规则处理。
  function isSshPublicKeyBlob(value) {
    return /^AAAA(?:B3NzaC1|C3NzaC1|E2VjZHNh)/.test(value);
  }

  // ---------- 网络标识判定 ----------

  // 返回 "invalid" | "reserved" | "public"。invalid(如版本号 126.0.6478.126)
  // 和 reserved(私网/回环/链路本地/CGNAT/组播/文档段)都不脱敏。
  function classifyIpv4(ip) {
    const parts = ip.split(".").map((v) => Number(v));
    if (parts.length !== 4 || parts.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
      return "invalid";
    }
    const [a, b, c] = parts;
    const reserved =
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 2)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
    return reserved ? "reserved" : "public";
  }

  // 众所周知的公共 DNS 等 anycast 地址:不指向用户,而且 ping 8.8.8.8 是
  // 最常见的网络排障动作,脱敏它们只会让 AI 失去关键上下文
  const WELL_KNOWN_IPS = new Set([
    "8.8.8.8", "8.8.4.4",
    "1.1.1.1", "1.0.0.1",
    "9.9.9.9", "149.112.112.112",
    "208.67.222.222", "208.67.220.220",
    "114.114.114.114", "223.5.5.5", "223.6.6.6", "119.29.29.29",
  ]);

  function isNonPublicIpv6(ip) {
    const normalized = String(ip || "").toLowerCase();
    return normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("2001:db8"); // 文档示例段
  }

  // 严格校验候选串是否为合法 IPv6(:: 压缩至多一处,分组数量正确)。
  // 时钟 13:42:58(3 组无压缩)、MAC、日志里的 hex:hex 都过不了这一关。
  function isValidIpv6(value) {
    if (!/^[0-9a-f:]+$/i.test(value)) return false;
    const compressed = value.split("::");
    if (compressed.length > 2) return false;
    const head = compressed[0] ? compressed[0].split(":") : [];
    const tail = compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
    if (head.some((g) => !g) || tail.some((g) => !g)) return false;
    if (compressed.length === 1) {
      if (head.length !== 8) return false;
    } else if (head.length + tail.length > 7) {
      return false;
    }
    return head.concat(tail).every((g) => /^[0-9a-f]{1,4}$/i.test(g));
  }

  const WELL_KNOWN_IPV6 = new Set([
    "2001:4860:4860::8888", "2001:4860:4860::8844",
    "2606:4700:4700::1111", "2606:4700:4700::1001",
  ]);

  // ---------- E 类兜底判定 ----------

  // 长混合随机串(base64 风格)。必须同时满足:
  //   长度 >= 20;同时含大小写(全大写=常量/环境变量名,全小写=普通单词);
  //   数字信号按长度分档 —— 20~27 字符要求数字 >= 3(驼峰标识符如
  //   parseInt32LittleEndian 数字很少),>= 28 字符只要求数字 >= 1
  //   (AWS secret 这类 40 字符 base64 可能只有一两个数字),
  //   带 base64 padding(+/=)则直接视为随机串;
  //   不在白名单(纯数字/纯 hex/数字分段/SSH 公钥/占位符)。
  function isLikelyRandomToken(value) {
    if (value.length < 20) return false;
    if (PLACEHOLDER_RE.test(value)) return false;
    if (isPureDigits(value) || isPureHex(value) || isDigitGroups(value)) return false;
    if (isSshPublicKeyBlob(value)) return false;
    if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
    if (/[+=]/.test(value)) return true;
    const digitCount = (value.match(/\d/g) || []).length;
    return digitCount >= (value.length >= 28 ? 1 : 3);
  }

  // ---------- A. 已知格式凭据 ----------

  const KNOWN_TOKEN_FORMATS = [
    // OpenAI / Anthropic / 通用 sk- pk- rk- ak- 前缀
    [/\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
    // GitHub PAT(经典与细粒度)
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
    [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_GITLAB_TOKEN]"],
    [/\bxox[a-z]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
    [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED_STRIPE_KEY]"],
    [/\bwhsec_[A-Za-z0-9]{16,}\b/g, "[REDACTED_STRIPE_KEY]"],
    [/\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]"],
    [/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED_NPM_TOKEN]"],
    [/\bpypi-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_PYPI_TOKEN]"],
    [/\bhf_[A-Za-z0-9]{20,}\b/g, "[REDACTED_HF_TOKEN]"],
    [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_SENDGRID_KEY]"],
    // JWT:header 固定以 eyJ 开头;签名段可能为空(alg=none)所以不加尾部 \b
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]"],
  ];

  // PEM 私钥块(RSA/EC/DSA/OPENSSH/ENCRYPTED/PGP)。终端快照可能只截到
  // BEGIN 行(END 被滚出屏幕),此时删到文本末尾;只截到尾部时,残余的
  // base64 行由 E 类兜底逐行处理。
  const PEM_PRIVATE_KEY_RE =
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g;

  // ---------- C. 键名驱动 ----------

  // 键名以敏感词结尾/开头(x-api-key、GITHUB_TOKEN、db.password 等都能命中);
  // \b 防止命中复数(max-tokens、secrets)。分隔符只认 = / : / =>,
  // 不认空格(否则 "wrong password entered" 会误伤)。
  const KEY_VALUE_RE =
    /([\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|credential|passphrase)\b[\w.-]*)(["']?\s*(?:=>|=|:)\s*)(["']?)([^\s"';,]+)/gi;

  // 值本身是占位/布尔/脱敏惯用写法时放行(sshd_config 的 yes/no、
  // 文档里的 <your-password>、compose 里的 ${DB_PASSWORD} 等)
  const SAFE_VALUE_RE =
    /^(?:true|false|yes|no|on|off|none|null|nil|undefined|prompt|publickey|keyboard-interactive|\*+|x+|\.+|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_]\w*)$/i;

  // ---------- 主入口 ----------

  function redactSensitiveText(text) {
    let out = String(text || "");

    // A. 已知格式凭据
    out = out.replace(PEM_PRIVATE_KEY_RE, "[REDACTED_PRIVATE_KEY]");
    for (const [pattern, replacement] of KNOWN_TOKEN_FORMATS) {
      out = out.replace(pattern, replacement);
    }

    // B. 协议/语法位置
    // URL 内嵌凭据:保留用户名(排查连接问题需要),只抹密码;用户名可为空(redis://:pass@)
    out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/@]+)@/gi, (m, scheme, user, pass) =>
      PLACEHOLDER_RE.test(pass) ? m : `${scheme}${user}:[REDACTED_URL_PASSWORD]@`);
    // Authorization 头:保留认证方案(Bearer/Basic...),抹凭据本体
    out = out.replace(/\b((?:proxy-)?authorization\s*:\s*)((?:bearer|basic|token|digest|negotiate|ntlm)\s+)?(\S+)/gi,
      (m, key, scheme, value) =>
        PLACEHOLDER_RE.test(value) ? m : `${key}${scheme || ""}[REDACTED_AUTH_HEADER]`);
    // 裸 Bearer xxx(日志里常见);值限定 token 字符集且 >=16,避免误伤普通英文
    out = out.replace(/\b(bearer\s+)([A-Za-z0-9._+/=-]{16,})/gi, (m, key, value) =>
      PLACEHOLDER_RE.test(value) ? m : `${key}[REDACTED_SECRET]`);
    // Cookie / Set-Cookie:整行值替换(curl -v、HTTP 调试输出)
    out = out.replace(/\b((?:set-)?cookie\s*:\s*)(.+)$/gim, (m, key, value) =>
      PLACEHOLDER_RE.test(value) ? m : `${key}[REDACTED_COOKIE]`);

    // C. 键名驱动
    out = out.replace(KEY_VALUE_RE, (m, key, sep, quote, value) => {
      if (PLACEHOLDER_RE.test(value) || SAFE_VALUE_RE.test(value)) return m;
      return `${key}${sep}${quote}[REDACTED_SECRET]`;
    });
    out = out.replace(/\b(sshpass\s+-p\s*)(["']?)([^\s"']+)/gi, (m, key, quote, value) =>
      PLACEHOLDER_RE.test(value) ? m : `${key}${quote}[REDACTED_SECRET]`);

    // D. 网络/设备标识(MAC 必须先于 IPv6,否则 aa:bb:cc:dd:ee:ff 会被当 IPv6)
    out = out.replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, "[REDACTED_MAC]");
    out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[REDACTED_UUID]");
    out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) =>
      classifyIpv4(ip) === "public" && !WELL_KNOWN_IPS.has(ip) ? "[REDACTED_PUBLIC_IP]" : ip);
    // IPv6:宽松候选({0,4} 允许空组,兼容 :: 在任意位置)+ isValidIpv6 严格校验。
    // 只抹冒号 >= 3 的公网地址:cc::dd 这种两组短串多半是代码里的作用域符号,
    // 保留;真实主机地址极少压缩到只剩两组。
    out = out.replace(/(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%[\w.-]+)?(?!\w|:|\.\d)/gi, (ip) => {
      const plain = ip.replace(/%.*$/, "");
      if (!isValidIpv6(plain)) return ip;
      if (isNonPublicIpv6(plain) || WELL_KNOWN_IPV6.has(plain.toLowerCase())) return ip;
      return (plain.match(/:/g) || []).length >= 3 ? "[REDACTED_PUBLIC_IPV6]" : ip;
    });
    // 主机提示符 user@host:~$ / user@host# —— 要求 : 后是路径/空白/行尾,
    // 避免误伤 image@sha256:... 摘要和 git@github.com:owner/repo 地址;
    // git log 的 <user@example.com> 不在此形态,保留
    out = out.replace(/(^|\s)([\w.-]+@[A-Za-z0-9_.-]+)(?=:(?:[~/]|\s|$)|[#$]\s?)/gm, "$1[REDACTED_HOST_PROMPT]");

    // E. 高熵兜底(最后执行,只处理前面规则都没碰的裸随机串)
    // = 只允许作为 base64 padding 出现在尾部,避免把 NAME=value 整体吞掉
    out = out.replace(/(?<![\w+-])[A-Za-z0-9_+-]{20,}={0,2}(?![\w+=-])/g, (token, offset, whole) => {
      if (!isLikelyRandomToken(token)) return token;
      // SHA256:xxx 形式的 ssh 主机密钥指纹是公开信息,保留可读性
      if (/sha(?:1|256|512):$/i.test(whole.slice(Math.max(0, offset - 8), offset))) return token;
      return "[REDACTED_TOKEN]";
    });

    return out;
  }

  const api = {
    redactSensitiveText,
    classifyIpv4,
    isNonPublicIpv6,
    isValidIpv6,
    isLikelyRandomToken,
  };

  global.ZeroTermRedact = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
