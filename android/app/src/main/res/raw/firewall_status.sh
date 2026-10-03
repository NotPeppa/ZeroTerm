# Read-only Linux firewall detection; follows the desktop ports panel.
emit_rule_lines() {
  backend=$1
  awk -v backend="$backend" '
    NF && count < 101 {
      line=tolower($0)
      action="other"
      if (line ~ /(^|[^a-z])(deny|reject|drop|block)([^a-z]|$)/) action="block"
      else if (line ~ /(^|[^a-z])(allow|accept|pass)([^a-z]|$)/) action="allow"
      else if (backend == "firewalld") action="allow"
      print "R|" backend "|" action "|" $0
      count++
    }
  '
}
found=0
if command -v ufw >/dev/null 2>&1; then
  found=1
  out=$(LC_ALL=C ufw status verbose 2>&1)
  case "$out" in
    *"Status: active"*)
      policy=$(printf '%s\n' "$out" | sed -n 's/^Default: \([^ ]*\) (incoming).*$/\1/p' | head -n 1)
      case "$policy" in deny|reject) policy=block;; allow) policy=allow;; *) policy=unknown;; esac
      printf 'ufw|active|%s|\n' "$policy"
      LC_ALL=C ufw status numbered 2>/dev/null | sed -n '/^\[[[:space:]]*[0-9][0-9]*\]/p' | emit_rule_lines ufw
      ;;
    *"Status: inactive"*) printf 'ufw|inactive|unknown|\n';;
    *) printf 'ufw|unknown|unknown|\n';;
  esac
fi
if command -v firewall-cmd >/dev/null 2>&1; then
  found=1
  state=$(LC_ALL=C firewall-cmd --state 2>/dev/null || true)
  if [ "$state" = running ]; then
    printf 'firewalld|active|unknown|\n'
    LC_ALL=C firewall-cmd --get-active-zones 2>/dev/null | awk 'NF && $1 !~ /^[[:space:]]/ { print $1 }' | while IFS= read -r zone; do
      for kind in services ports protocols source-ports forward-ports rich-rules; do
        values=$(LC_ALL=C firewall-cmd --zone="$zone" --list-$kind 2>/dev/null)
        if [ -n "$values" ]; then
          printf '%s\n' "$values" | awk -v zone="$zone" -v kind="$kind" 'NF { print zone " " kind ": " $0 }'
        fi
      done
      if LC_ALL=C firewall-cmd --zone="$zone" --query-masquerade >/dev/null 2>&1; then
        printf '%s\n' "$zone masquerade: enabled"
      fi
    done | emit_rule_lines firewalld
  elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    printf 'firewalld|active|unknown|\n'
  else
    printf 'firewalld|inactive|unknown|\n'
  fi
fi
if command -v nft >/dev/null 2>&1; then
  found=1
  rules=$(LC_ALL=C nft list ruleset 2>/dev/null)
  result=$?
  if [ "$result" -ne 0 ]; then
    printf 'nftables|unknown|unknown|\n'
  elif [ -n "$rules" ]; then
    printf 'nftables|active|unknown|\n'
    printf '%s\n' "$rules" | awk 'NF && tolower($0) ~ /(policy| dport| sport| saddr| daddr|ct state| accept| drop| reject| jump| counter)/' | emit_rule_lines nftables
  else
    printf 'nftables|inactive|unknown|\n'
  fi
fi
if command -v iptables >/dev/null 2>&1; then
  found=1
  rules=$(LC_ALL=C iptables -S 2>/dev/null)
  result=$?
  if [ "$result" -ne 0 ]; then
    printf 'iptables|unknown|unknown|\n'
  elif printf '%s\n' "$rules" | awk '$1=="-P" && $2=="INPUT" && $3!="ACCEPT" { active=1 } $1=="-A" && $2=="INPUT" { active=1 } END { exit active ? 0 : 1 }'; then
    printf 'iptables|active|unknown|\n'
    printf '%s\n' "$rules" | emit_rule_lines iptables
  else
    printf 'iptables|inactive|allow|\n'
  fi
fi
if [ "$found" -eq 0 ]; then printf 'none|unavailable|unknown|\n'; fi
true
