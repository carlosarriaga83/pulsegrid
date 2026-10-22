package com.pulsegrid.app.data

import android.content.Context

class AuthStore(context: Context) {
    // Usamos SharedPreferences normales para descartar fallos del KeyStore que ponen la pantalla negra
    private val prefs = context.getSharedPreferences("pulsegrid_auth_plain", Context.MODE_PRIVATE)

    @Volatile var accessToken: String? = null
        private set

    fun refreshToken(): String? = prefs.getString(KEY_REFRESH, null)

    fun save(access: String, refresh: String) {
        accessToken = access
        prefs.edit().putString(KEY_REFRESH, refresh).apply()
    }

    fun clear() {
        accessToken = null
        prefs.edit().remove(KEY_REFRESH).apply()
    }

    companion object { private const val KEY_REFRESH = "refresh_token" }
}