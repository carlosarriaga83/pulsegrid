package com.pulsegrid.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.google.gson.JsonElement
import com.pulsegrid.app.data.CapabilityDto
import com.pulsegrid.app.data.DeviceDto
import kotlinx.coroutines.delay

@Composable
fun PulsegridApp(model: PulsegridViewModel) {
    val state by model.state.collectAsState()
    
    // Forzamos un esquema de colores claro y básico para evitar la pantalla negra
    val colorScheme = lightColorScheme(
        primary = Color(0xFF0B8793),
        onPrimary = Color.White,
        background = Color.White,
        surface = Color.White,
        onBackground = Color.Black,
        onSurface = Color.Black
    )

    LaunchedEffect(state.signedIn) {
        while (state.signedIn) {
            delay(5000)
            model.refresh(silent = true)
        }
    }

    MaterialTheme(colorScheme = colorScheme) {
        // El Surface DEBE tener un color sólido para no heredar el negro del sistema
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = Color.White
        ) {
            if (state.signedIn) {
                Dashboard(state, model)
            } else {
                LoginScreen(state, model)
            }
        }
    }
}

@Composable
private fun LoginScreen(state: PulsegridState, model: PulsegridViewModel) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .statusBarsPadding(), // Evita que el contenido quede bajo la barra de estado
        verticalArrangement = Arrangement.Center
    ) {
        Text("PULSEGRID", color = Color(0xFF0B8793), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(10.dp))
        Text("Tu hogar,\nconectado.", color = Color.Black, style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
        Text("Controla cortinas y dispositivos desde un solo lugar.", modifier = Modifier.padding(top = 10.dp, bottom = 26.dp), color = Color.DarkGray)
        
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Correo") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.Black, unfocusedTextColor = Color.Black)
        )
        
        Spacer(Modifier.height(12.dp))
        
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Contraseña") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.Black, unfocusedTextColor = Color.Black)
        )
        
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 10.dp)) }
        
        Button(
            onClick = { model.login(email, password) },
            modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
            enabled = !state.loading && email.isNotBlank() && password.isNotBlank()
        ) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White)
            } else {
                Text("Iniciar sesión")
            }
        }
        
        Text("Conexión segura con Pulsegrid Cloud", modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 16.dp), color = Color.Gray, style = MaterialTheme.typography.labelMedium)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Dashboard(state: PulsegridState, model: PulsegridViewModel) {
    var showRegister by remember { mutableStateOf(false) }
    var showWifi by remember { mutableStateOf(false) }
    var selectedTab by remember { mutableStateOf(0) }
    var pendingWifi by remember { mutableStateOf<Pair<String, String>?>(null) }
    
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val credentials = pendingWifi
        pendingWifi = null
        if (granted && credentials != null) model.provisionWifi(credentials.first, credentials.second)
        else if (!granted) model.dismissMessage()
    }
    
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Pulsegrid", color = Color.Black, fontWeight = FontWeight.Bold)
                        Text(if (selectedTab == 0) "CONTROL CENTER" else "ACTIVIDAD", style = MaterialTheme.typography.labelSmall, color = Color(0xFF0B8793))
                    }
                },
                actions = {
                    IconButton(onClick = { model.refresh() }) { Icon(Icons.Default.Refresh, contentDescription = "Actualizar") }
                    TextButton(onClick = model::logout) { Text("Salir") }
                }
            )
        }
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets).padding(horizontal = 16.dp)) {
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = { selectedTab = 0 }, Modifier.weight(1f)) { Text("Dispositivos") }
                OutlinedButton(onClick = { selectedTab = 1 }, Modifier.weight(1f)) { Text("Comandos") }
            }
            if (state.error != null) Text(state.error!!, color = Color.Red, modifier = Modifier.padding(vertical = 8.dp))
            state.message?.let { Text(it, color = Color(0xFF0B8793), modifier = Modifier.padding(vertical = 6.dp)) }
            
            if (selectedTab == 0) {
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { showRegister = true }, Modifier.weight(1f)) { Icon(Icons.Default.Add, null); Text("Vincular") }
                    OutlinedButton(onClick = { showWifi = true }, Modifier.weight(1f)) { Icon(Icons.Default.Router, null); Text("Configurar Wi‑Fi") }
                }
                if (state.devices.isEmpty() && !state.loading) EmptyDevices(onRegister = { showRegister = true }, onWifi = { showWifi = true })
                else LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(state.devices, key = { it.id }) { device -> DeviceCard(device, model) }
                }
            } else {
                if (state.commands.isEmpty()) Text("Aún no hay comandos en el historial.", modifier = Modifier.padding(top = 24.dp), color = Color.Gray)
                else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(state.commands, key = { it.id }) { command ->
                        Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFF5F5F5))) {
                            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                                Text(command.deviceName ?: command.deviceId ?: "Dispositivo", fontWeight = FontWeight.SemiBold, color = Color.Black)
                                Text(command.command, color = Color(0xFF0B8793), style = MaterialTheme.typography.labelLarge)
                                Text("${command.status}${command.errorMessage?.let { " · $it" } ?: ""}", color = Color.DarkGray)
                            }
                        }
                    }
                }
            }
        }
    }
    
    if (showRegister) RegisterDialog(onDismiss = { showRegister = false }, onSubmit = { name, type, code -> model.register(name, type, code); showRegister = false })
    if (showWifi) WifiDialog(
        onDismiss = { showWifi = false },
        onSubmit = { ssid, password ->
            pendingWifi = ssid to password
            permissionLauncher.launch(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION)
            showWifi = false
        }
    )
}

@Composable
private fun EmptyDevices(onRegister: () -> Unit, onWifi: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 38.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Default.Tune, null, Modifier.size(46.dp), tint = Color(0xFF0B8793))
        Text("Tu espacio conectado empieza aquí", modifier = Modifier.padding(top = 12.dp), color = Color.Black, fontWeight = FontWeight.Bold)
        Text("Vincula una placa Pulsegrid ya grabada y configura su Wi‑Fi.", modifier = Modifier.padding(top = 6.dp), color = Color.DarkGray)
        Button(onClick = onRegister, modifier = Modifier.padding(top = 16.dp)) { Text("Vincular dispositivo") }
        TextButton(onClick = onWifi) { Text("Configurar Wi‑Fi") }
    }
}

@Composable
private fun DeviceCard(device: DeviceDto, model: PulsegridViewModel) {
    val telemetry = device.telemetry
    val target = telemetry?.get("servos")?.asJsonObject?.get("1")?.asJsonObject?.get("blind_target_percent")?.asFloat
        ?: telemetry?.get("position")?.asFloat ?: 50f
    var percent by remember(device.id, target) { mutableFloatStateOf(target.coerceIn(0f, 100f)) }
    val isCurtain = device.provider != "tuya" && (device.type.contains("cortina", true) || device.type.contains("curtain", true) || telemetry?.get("kind")?.asString == "curtain")
    val isServo = telemetry?.get("firmwareTarget")?.asString.equals("servo", ignoreCase = true)
    val servoStates = telemetry?.get("servos")?.takeIf { it.isJsonObject }?.asJsonObject
    val servoReady = !isServo || (1..2).all { id ->
        val servo = servoStates?.get(id.toString())?.takeIf { it.isJsonObject }?.asJsonObject
        servo?.get("blind_calibrated")?.asBoolean == true && servo?.get("position_recovery_required")?.asBoolean == false
    }
    val curtainExtra = if (isServo) mapOf("allServos" to true) else emptyMap()
    val reportedSpeed = telemetry?.get("servos")?.asJsonObject?.get("1")?.asJsonObject?.get("blind_target_speed")?.asInt ?: 1800
    var speed by remember(device.id, reportedSpeed) { mutableFloatStateOf(reportedSpeed.coerceIn(0, 1800).toFloat()) }
    val commandSpeed = if (isServo) speed.toInt() else 100
    val canMoveCurtain = device.status == "online" && servoReady && (!isServo || speed > 0f)
    
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(device.name, color = Color.Black, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text("${device.type} · ${device.provider.uppercase()}", color = Color.DarkGray, style = MaterialTheme.typography.labelMedium)
                }
                StatusBadge(device.status)
            }
            Text(device.id, color = Color.Gray, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 6.dp))
            val firmware = telemetry?.get("firmwareVersion")?.asString
            if (!firmware.isNullOrBlank()) Text("Firmware $firmware", color = Color.DarkGray, style = MaterialTheme.typography.labelSmall)
            Spacer(Modifier.height(10.dp))
            if (isCurtain) {
                val percentValue = if (telemetry?.get("servos")?.isJsonObject == true) {
                    telemetry.getAsJsonObject("servos").getAsJsonObject("1")?.get("blind_percent")?.asFloat
                } else telemetry?.get("position")?.asFloat
                Text("Posición ${percentValue?.let { "${it.toInt()}%" } ?: "—"}", color = Color.Black, fontWeight = FontWeight.SemiBold)
                if (!servoReady) Text("Completa la referencia y calibración Servo desde Pulsegrid antes de mover.", color = Color.Red, style = MaterialTheme.typography.bodySmall)
                if (isServo) {
                    Text("Velocidad Servo: ${speed.toInt()} (rango 0–1800)", color = Color.DarkGray, style = MaterialTheme.typography.bodySmall)
                    Slider(value = speed, onValueChange = { speed = it }, valueRange = 0f..1800f, steps = 17, enabled = device.status == "online")
                    if (speed == 0f) Text("Velocidad 0: selecciona al menos 1 para mover.", color = Color.Red, style = MaterialTheme.typography.bodySmall)
                }
                Slider(value = percent, onValueChange = { percent = it }, valueRange = 0f..100f, enabled = canMoveCurtain)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(onClick = { model.command(device.id, "curtain.open", mapOf("speed" to commandSpeed, "acceleration" to 50) + curtainExtra) }, Modifier.weight(1f), enabled = canMoveCurtain) { Text("Abrir") }
                    FilledTonalButton(onClick = { model.command(device.id, "curtain.close", mapOf("speed" to commandSpeed, "acceleration" to 50) + curtainExtra) }, Modifier.weight(1f), enabled = canMoveCurtain) { Text("Cerrar") }
                    OutlinedButton(onClick = { model.command(device.id, "curtain.stop") }, enabled = device.status == "online") { Text("Parar") }
                }
                Button(onClick = { model.command(device.id, "curtain.move", mapOf("percent" to percent.toInt(), "speed" to commandSpeed, "acceleration" to 50) + curtainExtra) }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp), enabled = canMoveCurtain) { Text("Mover a ${percent.toInt()}%") }
            } else if (device.provider == "tuya") {
                if (device.capabilities.isEmpty()) Text("Este dispositivo no publica funciones escribibles.", color = Color.DarkGray)
                else device.capabilities.forEach { TuyaCapability(device, it, model) }
            } else {
                Text("Telemetría disponible", color = Color.DarkGray)
                val summary = telemetry?.entrySet()?.take(4)?.joinToString(separator = " · ") { entry -> "${entry.key}: ${entry.value.readable()}" } ?: "Sin lecturas"
                Text(text = summary, color = Color.Black, style = MaterialTheme.typography.bodySmall)
            }
            device.lastCommandError?.let { Text(it, color = Color.Red, modifier = Modifier.padding(top = 8.dp)) }
        }
    }
}

@Composable
private fun TuyaCapability(device: DeviceDto, capability: CapabilityDto, model: PulsegridViewModel) {
    var value by remember(device.id, capability.code) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        OutlinedTextField(value, { value = it }, Modifier.fillMaxWidth(), label = { Text(capability.name ?: capability.code) }, singleLine = true, colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.Black, unfocusedTextColor = Color.Black))
        TextButton(onClick = {
            val typed: Any = when (capability.type?.lowercase()) {
                "boolean", "bool" -> value.equals("true", true)
                "integer" -> value.toIntOrNull() ?: value
                "number", "float", "double" -> value.toDoubleOrNull() ?: value
                else -> value
            }
            model.command(device.id, "tuya.set", mapOf("code" to capability.code, "value" to typed))
        }, enabled = value.isNotBlank() && device.status == "online") { Text("Enviar ${capability.name ?: capability.code}") }
        Divider(color = Color.LightGray)
    }
}

@Composable
private fun StatusBadge(status: String) {
    val color = when (status.lowercase()) { "online" -> Color(0xFF18865C); "provisioning" -> Color(0xFFB47712); else -> Color(0xFF7C8A91) }
    Surface(color = color.copy(alpha = 0.10f), shape = RoundedCornerShape(50)) {
        Text(status.uppercase(), Modifier.padding(horizontal = 10.dp, vertical = 5.dp), color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun RegisterDialog(onDismiss: () -> Unit, onSubmit: (String, String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("Servo") }
    var code by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Vincular dispositivo Pulsegrid", color = Color.Black) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Usa el código de 44 caracteres generado al grabar la placa.", color = Color.DarkGray)
            OutlinedTextField(name, { name = it }, label = { Text("Nombre") }, singleLine = true, colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.Black, unfocusedTextColor = Color.Black))
            OutlinedTextField(type, { type = it }, label = { Text("Tipo: Servo o GA25") }, singleLine = true, colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.Black, unfocusedTextColor = Color.Black))
            OutlinedTextField(code, { code = it.uppercase() }, label = { Text("Código Pulsegrid") }, singleLine = true, colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.Black, unfocusedTextColor = Color.Black))
        }
    }, confirmButton = { Button(onClick = { onSubmit(name, type, code) }, enabled = name.isNotBlank() && code.length == 44) { Text("Vincular") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } })
}

@Composable
private fun WifiDialog(onDismiss: () -> Unit, onSubmit: (String, String) -> Unit) {
    var ssid by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Configurar Wi‑Fi del ESP32", color = Color.Black) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("La app se conectará al AP Pulsegrid-Cortina del dispositivo. Android pedirá autorización.", color = Color.DarkGray)
            OutlinedTextField(ssid, { ssid = it }, label = { Text("Nombre de tu red Wi‑Fi") }, singleLine = true, colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.Black, unfocusedTextColor = Color.Black))
            OutlinedTextField(password, { password = it }, label = { Text("Contraseña Wi‑Fi") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Color.Black, unfocusedTextColor = Color.Black))
        }
    }, confirmButton = { Button(onClick = { onSubmit(ssid, password) }, enabled = ssid.isNotBlank()) { Text("Conectar dispositivo") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } })
}

private fun JsonElement.readable(): String = when {
    isJsonNull -> "—"
    isJsonPrimitive -> asJsonPrimitive.toString().removeSurrounding("\"", "\"")
    else -> toString()
}
