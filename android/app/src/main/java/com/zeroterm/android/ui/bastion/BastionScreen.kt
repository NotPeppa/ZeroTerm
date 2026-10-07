package com.zeroterm.android.ui.bastion

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.zeroterm.android.R
import com.zeroterm.android.data.ZeroTermRepository
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.ffi.HostSummary
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject

/** Saved passwords stay in Vault; only password-presence metadata returns to the UI. */
@Composable
fun BastionScreen(repository: ZeroTermRepository, onTerminal: (HostSummary) -> Unit, onFiles: (HostSummary) -> Unit, onOpenNavigation: () -> Unit) {
    val scope = rememberCoroutineScope()
    var profiles by remember { mutableStateOf(emptyList<JSONObject>()) }
    var selectedId by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var ca by remember { mutableStateOf("") }
    var advanced by remember { mutableStateOf(false) }
    // Discovery is never saved until the user confirms the displayed identity.
    var pending by remember { mutableStateOf<JSONObject?>(null) }
    var username by remember { mutableStateOf("") }
    // Never rememberSaveable: the password must not enter Android saved state.
    var password by remember { mutableStateOf("") }
    var rememberPassword by remember { mutableStateOf(true) }
    var assets by remember { mutableStateOf(emptyList<JSONObject>()) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    val identityChangedMessage = stringResource(R.string.bastion_identity_changed)
    val saved = profiles.firstOrNull { it.optString("id") == selectedId }
    val sameTrust = saved != null && url.trim().trimEnd('/') == saved.optString("api_url").trim().trimEnd('/') &&
        ca.trim() == (if (saved.isNull("ca_pem")) "" else saved.optString("ca_pem").trim())
    val shown = pending ?: saved?.takeIf { sameTrust }
    val useSavedPassword = sameTrust && saved?.optBoolean("has_password") == true &&
        saved.optString("username") == username.trim() && rememberPassword
    val changed = pending != null && saved != null &&
        listOf("server_id", "ssh_host", "ssh_port", "ssh_host_key_sha256").any { pending?.optString(it) != saved.optString(it) }
    fun select(p: JSONObject?) {
        selectedId = p?.optString("id").orEmpty()
        name = p?.optString("name").orEmpty(); url = p?.optString("api_url").orEmpty()
        ca = if (p == null || p.isNull("ca_pem")) "" else p.optString("ca_pem")
        advanced = ca.isNotBlank(); pending = null
        assets = emptyList(); username = p?.optString("username").orEmpty(); password = ""; message = ""
        rememberPassword = p == null || p.optBoolean("has_password") || username.isEmpty()
    }
    fun run(action: suspend () -> Unit) {
        if (busy) return
        busy = true; message = ""
        scope.launch {
            try { action() } catch (e: Exception) {
                if (e is CancellationException) throw e
                val detail = e.message.orEmpty()
                message = if (listOf("SERVER_ID_CHANGED", "GATEWAY_ADDRESS_CHANGED", "GATEWAY_HOST_KEY_CHANGED").any { it in detail })
                    "$identityChangedMessage\n$detail" else detail
            }
            finally { busy = false }
        }
    }
    suspend fun loadProfiles() {
        profiles = jsonObjects(JSONArray(repository.bastionProfiles().getOrThrow()))
    }
    suspend fun loadAssets() {
        assets = emptyList()
        assets = jsonObjects(JSONArray(repository.bastionAssets(selectedId).getOrThrow()))
    }
    suspend fun restoreAssets() {
        if (selectedId.isEmpty()) return
        try { loadAssets() } catch (e: Exception) {
            if (e is CancellationException || "UNAUTHENTICATED" !in e.message.orEmpty()) throw e
        }
    }
    suspend fun saveConnection(identity: JSONObject, login: Boolean) {
        val loginUser = username.trim()
        val secret = password
        val p = JSONObject(identity.toString()).put("id", selectedId)
            .put("name", name.trim().ifEmpty { java.net.URI(identity.getString("api_url")).host })
            .put("username", loginUser)
        val storedPassword = if (rememberPassword) secret.takeIf { it.isNotEmpty() } else ""
        val id = repository.bastionSaveProfile(p.toString(), storedPassword).getOrThrow()
        password = ""
        loadProfiles()
        select(profiles.first { it.optString("id") == id })
        if (login) {
            repository.bastionLogin(id, loginUser, secret).getOrThrow()
            loadAssets()
        }
    }
    suspend fun saveAsset(asset: JSONObject, account: JSONObject): HostSummary {
        val id = repository.bastionSaveAsset(selectedId, asset.getString("id"), account.getString("id")).getOrThrow()
        repository.refreshHosts().getOrThrow()
        return repository.hosts.value.first { it.id == id }
    }
    LaunchedEffect(Unit) { run { loadProfiles(); select(profiles.firstOrNull()); restoreAssets() } }
    Scaffold(topBar = { ZeroTopBar(title = stringResource(R.string.bastion_title), navigationIcon = { IconButton(onClick = onOpenNavigation) { Icon(Icons.Default.Menu, stringResource(R.string.common_menu)) } }) }) { padding ->
        Column(Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.bastion_hint), style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { select(null) }, enabled = !busy) { Text(stringResource(R.string.bastion_new)) }
                if (selectedId.isNotEmpty()) TextButton(onClick = { run { repository.bastionDeleteProfile(selectedId).getOrThrow(); loadProfiles(); select(null) } }, enabled = !busy) { Text(stringResource(R.string.common_delete)) }
            }
            profiles.forEach { p ->
                FilterChip(selected = selectedId == p.optString("id"), onClick = { select(p); run { restoreAssets() } }, enabled = !busy, label = { Text(p.optString("name")) })
            }
            Text(stringResource(R.string.bastion_config_hint), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(url, { url = it; pending = null }, label = { Text("HTTPS URL *") }, placeholder = { Text("https://bastion.example.com") }, singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.bastion_name)) }, placeholder = { Text(stringResource(R.string.bastion_name_placeholder)) }, singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(username, { username = it }, label = { Text(stringResource(R.string.bastion_username)) }, singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.bastion_password)) },
                placeholder = { if (useSavedPassword) Text(stringResource(R.string.bastion_saved_password)) },
                visualTransformation = PasswordVisualTransformation(), singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth().toggleable(value = rememberPassword, enabled = !busy, role = Role.Checkbox, onValueChange = { rememberPassword = it }), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = rememberPassword, onCheckedChange = null, enabled = !busy)
                Text(stringResource(R.string.bastion_remember_password), style = MaterialTheme.typography.bodyMedium)
            }
            TextButton(onClick = { advanced = !advanced }, enabled = !busy) { Text("${if (advanced) "▾" else "▸"} ${stringResource(R.string.bastion_advanced)}") }
            if (advanced) OutlinedTextField(ca, { ca = it; pending = null }, label = { Text(stringResource(R.string.bastion_ca)) }, minLines = 3, enabled = !busy, modifier = Modifier.fillMaxWidth())
            if (shown != null) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(if (pending != null) R.string.bastion_trust_pending else R.string.bastion_trust_saved), style = MaterialTheme.typography.titleSmall)
                        SelectionContainer {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("server_id: ${shown.optString("server_id")}")
                                val host = shown.optString("ssh_host").let { if (':' in it) "[$it]" else it }
                                Text("${stringResource(R.string.bastion_ssh_entry)}: $host:${shown.optInt("ssh_port")}")
                                Text("${stringResource(R.string.bastion_fingerprint)}: ${shown.optString("ssh_host_key_sha256")}")
                            }
                        }
                        Text(stringResource(when {
                            changed -> R.string.bastion_trust_changed
                            pending != null -> R.string.bastion_trust_note
                            else -> R.string.bastion_trust_saved_note
                        }), style = MaterialTheme.typography.bodySmall, color = if (changed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (pending != null) TextButton(onClick = { pending = null; message = "" }, enabled = !busy) { Text(stringResource(R.string.common_cancel)) }
                if (sameTrust && pending == null) TextButton(onClick = { run { saveConnection(saved!!, false) } }, enabled = !busy) { Text(stringResource(R.string.common_save)) }
                Button(onClick = { run {
                    val identity = pending ?: saved?.takeIf { sameTrust }
                    if (identity == null) {
                        pending = JSONObject(repository.bastionProbe(name, url, ca.takeIf { it.isNotBlank() }).getOrThrow())
                    } else {
                        saveConnection(identity, true)
                    }
                } }, enabled = !busy && url.isNotBlank() && username.isNotBlank() && (password.isNotEmpty() || useSavedPassword)) {
                    Text(stringResource(when {
                        pending != null -> R.string.bastion_confirm_login
                        sameTrust -> R.string.bastion_save_login
                        else -> R.string.bastion_probe
                    }))
                }
            }
            HorizontalDivider()
            if (selectedId.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { run { assets = emptyList(); repository.bastionLogout(selectedId).getOrThrow() } }, enabled = !busy) { Text(stringResource(R.string.bastion_logout)) }
                    TextButton(onClick = { run { loadAssets() } }, enabled = !busy) { Text(stringResource(R.string.common_refresh)) }
                }
            }
            if (busy) CircularProgressIndicator()
            if (message.isNotEmpty()) Text(message, color = MaterialTheme.colorScheme.error)
            assets.forEach { asset -> jsonObjects(asset.getJSONArray("accounts")).forEach { account ->
                val caps = account.getJSONArray("capabilities").let { a -> (0 until a.length()).map { a.getString(it) } }
                Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                    Text("${asset.getString("name")} · ${account.getString("username")}")
                    Text(caps.joinToString(", "), style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { run { saveAsset(asset,account) } }, enabled = !busy) { Text(stringResource(R.string.bastion_favorite)) }
                        if ("shell" in caps) TextButton(onClick = { run { onTerminal(saveAsset(asset,account)) } }, enabled = !busy) { Text(stringResource(R.string.bastion_terminal)) }
                        if ("sftp" in caps) TextButton(onClick = { run { onFiles(saveAsset(asset,account)) } }, enabled = !busy) { Text("SFTP") }
                    }
                } }
            } }
        }
    }
}
private fun jsonObjects(array: JSONArray): List<JSONObject> = (0 until array.length()).map { array.getJSONObject(it) }
