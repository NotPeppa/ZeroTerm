package com.zeroterm.android.ui.hosts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.zeroterm.android.data.ZeroTermRepository
import com.zeroterm.ffi.HostSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class HostsUiState(
    val hosts: List<HostSummary> = emptyList(),
    val query: String = "",
    val loading: Boolean = false,
    val error: String? = null,
)

class HostsViewModel(
    private val repository: ZeroTermRepository,
) : ViewModel() {
    private val query = MutableStateFlow("")
    private val loading = MutableStateFlow(false)
    private val error = MutableStateFlow<String?>(null)

    val state: StateFlow<HostsUiState> = combine(
        repository.hosts,
        query,
        loading,
        error,
    ) { hosts, q, load, err ->
        val filtered = if (q.isBlank()) {
            hosts
        } else {
            val needle = q.lowercase()
            hosts.filter {
                it.name.lowercase().contains(needle) ||
                    it.host.lowercase().contains(needle) ||
                    it.user.lowercase().contains(needle)
            }
        }
        HostsUiState(hosts = filtered, query = q, loading = load, error = err)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HostsUiState())

    init {
        refresh()
    }

    fun onQueryChange(value: String) {
        query.value = value
    }

    fun refresh() {
        viewModelScope.launch {
            loading.value = true
            error.value = null
            repository.refreshHosts().onFailure { e ->
                error.value = e.message
            }
            loading.value = false
        }
    }

    companion object {
        fun factory(repository: ZeroTermRepository): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    return HostsViewModel(repository) as T
                }
            }
    }
}
