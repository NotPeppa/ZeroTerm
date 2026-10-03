package com.zeroterm.android.data

import com.zeroterm.ffi.ForwardKind
import com.zeroterm.ffi.PortForwardInput

internal enum class ForwardFormProblem { Host, BindAddress, BindPort, TargetAddress, TargetPort }

internal data class PortForwardDraft(
    val id: String?, val hostId: String, val kind: ForwardKind,
    val bindAddress: String, val bindPort: String,
    val targetAddress: String, val targetPort: String, val enabled: Boolean = true,
) {
    fun problem(): ForwardFormProblem? = when {
        hostId.isBlank() -> ForwardFormProblem.Host
        !validAddress(bindAddress) -> ForwardFormProblem.BindAddress
        port(bindPort) == null -> ForwardFormProblem.BindPort
        kind != ForwardKind.DYNAMIC && !validAddress(targetAddress) -> ForwardFormProblem.TargetAddress
        kind != ForwardKind.DYNAMIC && port(targetPort) == null -> ForwardFormProblem.TargetPort
        else -> null
    }

    fun input(): PortForwardInput {
        require(problem() == null)
        return PortForwardInput(
            id, hostId, kind, bindAddress.trim(), port(bindPort)!!.toUShort(),
            if (kind == ForwardKind.DYNAMIC) "" else targetAddress.trim(),
            if (kind == ForwardKind.DYNAMIC) 0u.toUShort() else port(targetPort)!!.toUShort(), enabled,
        )
    }

    private fun validAddress(value: String): Boolean = value.trim().let {
        it.isNotEmpty() && it.length <= 255 && it.none { char -> char.isWhitespace() || char.isISOControl() }
    }
    private fun port(value: String): Int? = value.trim().toIntOrNull()?.takeIf { it in 1..65535 }
}

internal fun forwardEndpoint(address: String, port: UShort): String =
    "${if (':' in address && !address.startsWith('[')) "[$address]" else address}:$port"
