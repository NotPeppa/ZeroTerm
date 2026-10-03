package com.zeroterm.android.data

internal data class FirewallRule(val action: String, val text: String)

internal data class FirewallStatus(
    val status: String = "unknown",
    val backend: String = "",
    val inboundPolicy: String = "unknown",
    val rules: List<FirewallRule> = emptyList(),
    val rulesTruncated: Boolean = false,
)

/** Prefer an active manager over an underlying nftables/iptables ruleset. */
internal fun parseFirewallStatus(output: String): FirewallStatus {
    val backends = mapOf("ufw" to "UFW", "firewalld" to "firewalld", "nftables" to "nftables", "iptables" to "iptables")
    val statusRanks = mapOf("active" to 3, "unknown" to 2, "inactive" to 1, "unavailable" to 0)
    val backendRanks = mapOf("ufw" to 5, "firewalld" to 4, "nftables" to 1, "iptables" to 0)
    val candidates = mutableListOf<Pair<String, FirewallStatus>>()
    val rules = mutableListOf<Pair<String, FirewallRule>>()
    output.lineSequence().forEach { raw ->
        val fields = raw.trim().split('|', limit = 4).map { it.trim() }
        if (fields.firstOrNull() == "R") {
            if (fields.size != 4 || fields[1] !in backends) return@forEach
            val text = fields[3].split(Regex("\\s+")).joinToString(" ").take(512)
            if (text.isBlank()) return@forEach
            val action = when (fields[2]) {
                "allow", "block" -> fields[2]
                else -> when {
                    Regex("(?i)\\b(deny|reject|drop|block)\\b").containsMatchIn(text) -> "block"
                    Regex("(?i)\\b(allow|accept|pass)\\b").containsMatchIn(text) -> "allow"
                    else -> "other"
                }
            }
            rules += fields[1] to FirewallRule(action, text)
        } else {
            if (fields.size < 2 || fields[1] !in statusRanks) return@forEach
            if (fields[0] !in backends && fields[0] != "none") return@forEach
            candidates += fields[0] to FirewallStatus(
                status = fields[1],
                backend = backends[fields[0]].orEmpty(),
                inboundPolicy = fields.getOrNull(2)?.takeIf { it == "block" || it == "allow" } ?: "unknown",
            )
        }
    }
    val (selectedBackend, selected) = candidates.maxWithOrNull(
        compareBy<Pair<String, FirewallStatus>> { statusRanks[it.second.status] ?: 0 }
            .thenBy { backendRanks[it.first] ?: 0 },
    ) ?: return FirewallStatus()
    val matchingRules = rules.filter { it.first == selectedBackend }.map { it.second }
    return selected.copy(rules = matchingRules.take(100), rulesTruncated = matchingRules.size > 100)
}
