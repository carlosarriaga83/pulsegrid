package com.pulsegrid.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pulsegrid.app.data.ApiFactory
import com.pulsegrid.app.data.AuthStore
import com.pulsegrid.app.data.PulsegridRepository
import com.pulsegrid.app.provisioning.WifiProvisioner
import com.pulsegrid.app.ui.PulsegridApp
import com.pulsegrid.app.ui.PulsegridViewModel
import com.pulsegrid.app.ui.PulsegridViewModelFactory

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Android 15+ requiere esto para un dibujado correcto
        enableEdgeToEdge()
        
        val authStore = AuthStore(applicationContext)
        val repository = PulsegridRepository(ApiFactory.create(BuildConfig.PULSEGRID_API_BASE_URL, authStore), authStore)
        val provisioner = WifiProvisioner(applicationContext)

        setContent {
            // Este Surface es VITAL para evitar la pantalla negra al forzar un color de fondo sólido
            Surface(
                modifier = Modifier.fillMaxSize(),
                color = Color.White
            ) {
                val model: PulsegridViewModel = viewModel(
                    factory = PulsegridViewModelFactory(repository, provisioner)
                )
                PulsegridApp(model)
            }
        }
    }
}