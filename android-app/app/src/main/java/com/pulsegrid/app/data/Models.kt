package com.pulsegrid.app.data

import com.google.gson.JsonObject

data class UserDto(val name: String, val email: String, val role: String)
data class LoginRequest(val email: String, val password: String)
data class RefreshRequest(val refreshToken: String)
data class LogoutRequest(val refreshToken: String)
data class AuthResponse(val accessToken: String, val refreshToken: String, val expiresIn: Long, val user: UserDto)

data class CapabilityDto(
    val code: String,
    val name: String? = null,
    val type: String? = null,
    val values: JsonObject? = null
)

data class DeviceDto(
    val id: String,
    val name: String,
    val type: String,
    val provider: String = "pulsegrid",
    val capabilities: List<CapabilityDto> = emptyList(),
    val status: String = "offline",
    val report: String? = null,
    val telemetry: JsonObject? = null,
    val lastCommandStatus: String? = null,
    val lastCommandError: String? = null
)
data class DevicesResponse(val devices: List<DeviceDto> = emptyList())
data class RegisterDeviceRequest(val name: String, val type: String, val deviceCode: String)
data class RegisterDeviceResponse(val ok: Boolean, val deviceId: String, val status: String)
data class CommandRequest(val deviceId: String, val command: String, val payload: Map<String, Any>)
data class CommandResponse(val ok: Boolean, val commandId: Long, val status: String, val error: String? = null)
data class CommandsResponse(val commands: List<CommandDto> = emptyList())
data class CommandDto(
    val id: Long,
    val command: String,
    val payload: JsonObject? = null,
    val status: String,
    val errorMessage: String? = null,
    val createdAt: String? = null,
    val deviceId: String? = null,
    val deviceName: String? = null
)