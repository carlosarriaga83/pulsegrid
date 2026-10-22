package com.pulsegrid.app.data

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface PulsegridApi {
    @POST("api/mobile/auth/login") suspend fun login(@Body body: LoginRequest): AuthResponse
    @POST("api/mobile/auth/refresh") suspend fun refresh(@Body body: RefreshRequest): AuthResponse
    @POST("api/mobile/auth/logout") suspend fun logout(@Body body: LogoutRequest): Response<Unit>
    @GET("api/mobile/devices") suspend fun devices(): DevicesResponse
    @POST("api/mobile/devices") suspend fun registerDevice(@Body body: RegisterDeviceRequest): RegisterDeviceResponse
    @POST("api/mobile/commands") suspend fun sendCommand(@Body body: CommandRequest): CommandResponse
    @GET("api/mobile/commands") suspend fun commands(): CommandsResponse
}

object ApiFactory {
    fun create(baseUrl: String, authStore: AuthStore): PulsegridApi {
        val auth = Interceptor { chain ->
            val request = chain.request().newBuilder().apply {
                authStore.accessToken?.let { header("Authorization", "Bearer $it") }
            }.build()
            chain.proceed(request)
        }
        val client = OkHttpClient.Builder().addInterceptor(auth).build()
        return Retrofit.Builder()
            .baseUrl(if (baseUrl.endsWith('/')) baseUrl else "$baseUrl/")
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(PulsegridApi::class.java)
    }
}