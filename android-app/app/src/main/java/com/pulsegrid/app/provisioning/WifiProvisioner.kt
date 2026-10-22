package com.pulsegrid.app.provisioning

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.PatternMatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlin.coroutines.resume

class WifiProvisioner(context: Context) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    suspend fun configure(homeSsid: String, homePassword: String): String {
        check(Build.VERSION.SDK_INT >= 29) { "La configuración Wi‑Fi desde la app requiere Android 10 o posterior." }
        require(homeSsid.isNotBlank()) { "Escribe el nombre de tu red Wi‑Fi." }
        val network = connectToPulsegridAp()
        return try {
            manager.bindProcessToNetwork(network)
            withContext(Dispatchers.IO) { postCredentials(homeSsid.trim(), homePassword) }
        } finally {
            manager.bindProcessToNetwork(null)
            networkCallback?.let { runCatching { manager.unregisterNetworkCallback(it) } }
            networkCallback = null
        }
    }

    private suspend fun connectToPulsegridAp(): Network = suspendCancellableCoroutine { continuation ->
        val specifier = WifiNetworkSpecifier.Builder()
            .setSsidPattern(PatternMatcher("Pulsegrid-Cortina-", PatternMatcher.PATTERN_PREFIX))
            .build()
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(specifier)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (continuation.isActive) continuation.resume(network)
            }
            override fun onUnavailable() {
                if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException("No se pudo conectar al punto de acceso Pulsegrid.")))
            }
        }
        networkCallback = callback
        manager.requestNetwork(request, callback)
        continuation.invokeOnCancellation { runCatching { manager.unregisterNetworkCallback(callback) } }
    }

    private fun postCredentials(ssid: String, password: String): String {
        val body = "ssid=${encode(ssid)}&password=${encode(password)}"
        val connection = URL("http://192.168.4.1/save").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            if (code !in 200..299) throw IllegalStateException("El ESP32 respondió HTTP $code.")
            return "Datos enviados. El dispositivo reiniciará y tratará de conectarse a tu red."
        } finally { connection.disconnect() }
    }

    private fun encode(value: String) = URLEncoder.encode(value, Charsets.UTF_8.name())
}