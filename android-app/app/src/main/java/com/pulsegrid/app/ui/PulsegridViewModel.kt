package com.pulsegrid.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.pulsegrid.app.data.*
import com.pulsegrid.app.provisioning.WifiProvisioner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class PulsegridState(
    val signedIn: Boolean = false,
    val loading: Boolean = false,
    val devices: List<DeviceDto> = emptyList(),
    val commands: List<CommandDto> = emptyList(),
    val message: String? = null,
    val error: String? = null
)

class PulsegridViewModel(
    private val repository: PulsegridRepository,
    private val provisioner: WifiProvisioner
) : ViewModel() {
    private val mutableState = MutableStateFlow(PulsegridState())
    val state: StateFlow<PulsegridState> = mutableState.asStateFlow()

    init {
        // Lanzamos la restauración en IO para no bloquear el inicio de la UI
        viewModelScope.launch {
            try {
                val restored = withContext(Dispatchers.IO) {
                    repository.restoreSession()
                }
                if (restored) {
                    mutableState.update { it.copy(signedIn = true) }
                    refresh(silent = true)
                }
            } catch (e: Exception) {
                // Si falla la red al inicio, simplemente mostramos el login
            }
        }
    }

    fun login(email: String, password: String) = launchRequest {
        repository.login(email, password)
        mutableState.update { it.copy(signedIn = true, message = "Sesión iniciada.") }
        refresh()
    }

    fun logout() = launchRequest {
        repository.logout()
        mutableState.value = PulsegridState(message = "Sesión cerrada.")
    }

    fun refresh(silent: Boolean = false) = launchRequest(silent) {
        val devices = repository.devices()
        val commands = repository.commands()
        mutableState.update { it.copy(signedIn = true, devices = devices, commands = commands, error = null) }
    }

    fun register(name: String, type: String, code: String) = launchRequest {
        repository.register(RegisterDeviceRequest(name.trim(), type, code.trim()))
        mutableState.update { it.copy(message = "Dispositivo vinculado.") }
        refresh()
    }

    fun command(deviceId: String, command: String, payload: Map<String, Any> = emptyMap()) = launchRequest {
        val result = repository.sendCommand(CommandRequest(deviceId, command, payload))
        mutableState.update { it.copy(message = "Comando enviado: ${result.status}.") }
        refresh(silent = true)
    }

    fun provisionWifi(ssid: String, password: String) = launchRequest {
        val message = provisioner.configure(ssid, password)
        mutableState.update { it.copy(message = message) }
        delay(1500)
        refresh(silent = true)
    }

    fun dismissMessage() = mutableState.update { it.copy(message = null, error = null) }

    private fun launchRequest(silent: Boolean = false, block: suspend () -> Unit) {
        viewModelScope.launch {
            mutableState.update { it.copy(loading = !silent, error = null, message = if (silent) it.message else null) }
            try {
                withContext(Dispatchers.IO) { block() }
            } catch (error: Exception) {
                mutableState.update { 
                    it.copy(
                        error = error.message ?: "Error de conexión", 
                        signedIn = if (error.message?.contains("401") == true) false else it.signedIn
                    ) 
                }
            } finally {
                mutableState.update { it.copy(loading = false) }
            }
        }
    }
}

class PulsegridViewModelFactory(
    private val repository: PulsegridRepository,
    private val provisioner: WifiProvisioner
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        return PulsegridViewModel(repository, provisioner) as T
    }
}
