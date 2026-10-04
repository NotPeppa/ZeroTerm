package com.zeroterm.android.ui.bastion

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.zeroterm.android.R
import com.zeroterm.android.data.ZeroTermRepository
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.ffi.HostSummary
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** Public configuration and asset metadata only. Secrets remain in the Rust login. */
@Composable
fun BastionScreen(repository: ZeroTermRepository, onTerminal: (HostSummary) -> Unit, onFiles: (HostSummary) -> Unit, onOpenNavigation: () -> Unit) {
    val scope = rememberCoroutineScope()
    var profiles by remember { mutableStateOf(emptyList<JSONObject>()) }
    var selectedId by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var serverId by remember { mutableStateOf("") }
    var sshHost by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("2222") }
    var fingerprint by remember { mutableStateOf("") }
    var ca by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    // Never rememberSaveable: the password must not enter Android saved state.
    var password by remember { mutableStateOf("") }
    var assets by remember { mutableStateOf(emptyList<JSONObject>()) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    fun select(p: JSONObject?) {
        selectedId = p?.optString("id").orEmpty()
        name = p?.optString("name").orEmpty(); url = p?.optString("api_url").orEmpty()
        serverId = p?.optString("server_id").orEmpty(); sshHost = p?.optString("ssh_host").orEmpty()
        port = p?.optInt("ssh_port", 2222)?.toString() ?: "2222"
        fingerprint = p?.optString("ssh_host_key_sha256").orEmpty()
        ca = if (p == null || p.isNull("ca_pem")) "" else p.optString("ca_pem")
        assets = emptyList(); password = ""; message = ""
    }
    fun run(action: suspend () -> Unit) {
        if (busy) return
        busy = true; message = ""
        scope.launch {
            try { action() } catch (e: Exception) { message = e.message.orEmpty() }
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
    suspend fun saveAsset(asset: JSONObject, account: JSONObject): HostSummary {
        val id = repository.bastionSaveAsset(selectedId, asset.getString("id"), account.getString("id")).getOrThrow()
        repository.refreshHosts().getOrThrow()
        return repository.hosts.value.first { it.id == id }
    }
    LaunchedEffect(Unit) { run { loadProfiles() } }
    Scaffold(topBar = { ZeroTopBar(title = stringResource(R.string.bastion_title), navigationIcon = { IconButton(onClick = onOpenNavigation) { Icon(Icons.Default.Menu, stringResource(R.string.common_menu)) } }) }) { padding ->
        Column(Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.bastion_hint), style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { select(null) }, enabled = !busy) { Text(stringResource(R.string.bastion_new)) }
                if (selectedId.isNotEmpty()) TextButton(onClick = { run { repository.bastionDeleteProfile(selectedId).getOrThrow(); loadProfiles(); select(null) } }, enabled = !busy) { Text(stringResource(R.string.common_delete)) }
            }
            profiles.forEach { p ->
                FilterChip(selected = selectedId == p.optString("id"), onClick = { select(p) }, enabled = !busy, label = { Text(p.optString("name")) })
            }
            OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.bastion_name)) }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(url, { url = it }, label = { Text("HTTPS URL") }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(serverId, { serverId = it }, label = { Text("server_id") }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(sshHost, { sshHost = it }, label = { Text("SSH Host") }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(port, { port = it }, label = { Text("SSH Port") }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(fingerprint, { fingerprint = it }, label = { Text(stringResource(R.string.bastion_fingerprint)) }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(ca, { ca = it }, label = { Text(stringResource(R.string.bastion_ca)) }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            Button(onClick = { run {
                val p = JSONObject().put("id", selectedId).put("name",name).put("api_url",url).put("server_id",serverId)
                    .put("ssh_host",sshHost).put("ssh_port",port.toInt()).put("ssh_host_key_sha256",fingerprint).put("ca_pem",if(ca.isBlank()) JSONObject.NULL else ca)
                selectedId = repository.bastionSaveProfile(p.toString()).getOrThrow(); assets = emptyList(); password = ""; loadProfiles()
            } }, enabled = !busy) { Text(stringResource(R.string.common_save)) }
            HorizontalDivider()
            OutlinedTextField(username, { username = it }, label = { Text(stringResource(R.string.bastion_username)) }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.bastion_password)) }, visualTransformation = PasswordVisualTransformation(), enabled = !busy, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { val secret = password; password = ""; run { repository.bastionLogin(selectedId,username,secret).getOrThrow(); loadAssets() } }, enabled = !busy && selectedId.isNotEmpty()) { Text(stringResource(R.string.bastion_login)) }
                TextButton(onClick = { run { assets = emptyList(); repository.bastionLogout(selectedId).getOrThrow() } }, enabled = !busy && selectedId.isNotEmpty()) { Text(stringResource(R.string.bastion_logout)) }
                TextButton(onClick = { run { loadAssets() } }, enabled = !busy && selectedId.isNotEmpty()) { Text(stringResource(R.string.common_refresh)) }
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
