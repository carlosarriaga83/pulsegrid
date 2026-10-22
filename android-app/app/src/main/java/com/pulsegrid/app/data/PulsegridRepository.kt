package com.pulsegrid.app.data

import retrofit2.HttpException

class PulsegridRepository(private val api: PulsegridApi, private val auth: AuthStore) {
    suspend fun login(email: String, password: String): UserDto {
        val result = api.login(LoginRequest(email.trim(), password))
        auth.save(result.accessToken, result.refreshToken)
        return result.user
    }

    suspend fun restoreSession(): Boolean {
        val refresh = auth.refreshToken() ?: return false
        return runCatching {
            val result = api.refresh(RefreshRequest(refresh))
            auth.save(result.accessToken, result.refreshToken)
        }.isSuccess.also { if (!it) auth.clear() }
    }

    suspend fun logout() {
        val refresh = auth.refreshToken()
        if (refresh != null) runCatching { api.logout(LogoutRequest(refresh)) }
        auth.clear()
    }

    suspend fun devices(): List<DeviceDto> = withRefresh { api.devices().devices }
    suspend fun commands(): List<CommandDto> = withRefresh { api.commands().commands }
    suspend fun register(body: RegisterDeviceRequest): RegisterDeviceResponse = withRefresh { api.registerDevice(body) }
    suspend fun sendCommand(body: CommandRequest): CommandResponse = withRefresh { api.sendCommand(body) }

    private suspend fun <T> withRefresh(call: suspend () -> T): T {
        try { return call() }
        catch (error: HttpException) {
            if (error.code() != 401 || !restoreSession()) throw error
            return call()
        }
    }
}