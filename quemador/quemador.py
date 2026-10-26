import json
import hashlib
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
import urllib.parse
import urllib.request
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None
    list_ports = None


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = Path(__file__).resolve().parent
VENV_PYTHON = APP_DIR / ".venv" / "Scripts" / "python.exe"
SERVO_DIR = ROOT / "dispositivos" / "servo"
GA25_DIR = ROOT / "dispositivos" / "ga25" / "esp32_motor"
TENSTAR_DIR = ROOT / "dispositivos" / "tenstar"
DEFAULT_API_URL = "https://pulse.2api2.com"
DEVICE_CODE_DOMAIN = "pulsegrid-device-code-v1:"
MPREMOTE_RETRY_ATTEMPTS = 5
MPREMOTE_RETRY_DELAY_SECONDS = 1
ESP_TYPES = ("Auto", "ESP32", "ESP32-S2", "ESP32-S3", "ESP32-C3", "ESP32-C6", "ESP32-H2")
MODEL_PROFILES = {
    "servo": {
        "label": "Servo",
        "directory": SERVO_DIR,
        "files": ("main.py", "cloud_client.py", "board_led.py", "captive_portal.py", "cortina.py", "servo_calibration.py", "stservo.py", "boot.py", "ota_boot.py", "pulsegrid_ota.py", "wifi_recovery.py"),
        "remove": ("pulsegrid_min.py", "pulsegrid_bootstrap.py", "pulsegrid_commands.py", "webserver_min.py", "webserver_portal.py", "cloud_loop.py", "config.py", "wifi_config.py", "pulsegrid_ota.py", "pulsegrid_config.py", "motor_curtain.py"),
        "config": "config.py",
    },
    "ga25": {
        "label": "GA25",
        "directory": GA25_DIR,
        "files": ("main.py", "captive_portal.py", "motor_curtain.py", "boot.py", "ota_boot.py", "wifi_recovery.py"),
        "remove": ("pulsegrid_min.py", "webserver_min.py", "cortina.py", "stservo.py", "ssd1306.py", "wifi_config.py", "pulsegrid_config.py"),
        "config": "config.py",
    },
    "tenstar": {
        "label": "Tenstar C3 Super Mini",
        "directory": TENSTAR_DIR,
        "files": ("boot.py", "main.py", "tenstar_motor.py", "ota_boot.py", "pulsegrid_ota.py"),
        "sources": {"ota_boot.py": SERVO_DIR / "ota_boot.py", "pulsegrid_ota.py": SERVO_DIR / "pulsegrid_ota.py"},
        "remove": ("cortina.py", "stservo.py", "servo_calibration.py", "motor_curtain.py", "captive_portal.py", "pulsegrid_firmware.py"),
        "config": "config.py",
    },
}


class BurnerError(RuntimeError):
    pass


def normalize_mac_address(value):
    mac = str(value or "").strip().replace(":", "").replace("-", "").replace(".", "").upper()
    if not re.fullmatch(r"[0-9A-F]{12}", mac):
        raise BurnerError("La MAC debe contener exactamente 12 caracteres hexadecimales")
    return mac


def device_code_from_mac(value):
    mac = normalize_mac_address(value)
    suffix = hashlib.sha256((DEVICE_CODE_DOMAIN + mac).encode("ascii")).hexdigest()[:32].upper()
    return mac + suffix


class BurnerApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Pulsegrid | Quemador ESP32")
        self.geometry("980x760")
        self.minsize(820, 620)
        self.events = queue.Queue()
        self.running = False
        self.process_lock = threading.Lock()
        self.child_processes = set()
        self.temp_files = []
        self.model = tk.StringVar(value="servo")
        self.esp_type = tk.StringVar(value="Auto")
        self.port = tk.StringVar()
        self.firmware = tk.StringVar()
        self.custom_dir = tk.StringVar()
        self.api_url = tk.StringVar(value=DEFAULT_API_URL)
        self.device_id = tk.StringVar(value="PULSE_XX")
        self.device_mac = tk.StringVar()
        self.device_code = tk.StringVar()
        self.wifi_ssid = tk.StringVar()
        self.wifi_password = tk.StringVar()
        self.full_travel = tk.IntVar(value=15000)
        self.pulses_per_revolution = tk.IntVar(value=1980)
        self.tenstar_minimum_speed = tk.IntVar(value=20)
        self.reversed = tk.BooleanVar(value=False)
        self.commands = tk.BooleanVar(value=True)
        self.flash_micropython = tk.BooleanVar(value=True)
        self.clean_files = tk.BooleanVar(value=True)
        self.status = tk.StringVar(value="Listo. Selecciona el puerto y el modelo.")
        self._build_style()
        self._build_ui()
        self._model_changed()
        self.refresh_ports()
        self.after(100, self._drain_events)

    def _build_style(self):
        style = ttk.Style(self)
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass
        style.configure("Title.TLabel", font=("Segoe UI", 18, "bold"))
        style.configure("Section.TLabelframe.Label", font=("Segoe UI", 10, "bold"))
        style.configure("Action.TButton", padding=(12, 7))

    def _build_ui(self):
        root = ttk.Frame(self, padding=16)
        root.pack(fill="both", expand=True)
        ttk.Label(root, text="Quemador ESP32", style="Title.TLabel").pack(anchor="w")
        ttk.Label(root, text="Detecta el chip, verifica MicroPython y carga el perfil correcto del dispositivo.").pack(anchor="w", pady=(2, 14))

        selection = ttk.LabelFrame(root, text="1. Placa y perfil", style="Section.TLabelframe", padding=10)
        selection.pack(fill="x", pady=(0, 10))
        self._field(selection, "Modelo", self.model, ("servo", "ga25", "tenstar", "otros"), 0, self._model_changed)
        self._field(selection, "Tipo ESP32", self.esp_type, ESP_TYPES, 1)
        ttk.Label(selection, text="Puerto COM").grid(row=0, column=4, sticky="w", padx=(18, 5), pady=4)
        self.port_box = ttk.Combobox(selection, textvariable=self.port, state="readonly", width=18)
        self.port_box.grid(row=0, column=5, sticky="ew", pady=4)
        ttk.Button(selection, text="Actualizar", command=self.refresh_ports).grid(row=0, column=6, padx=(6, 0), pady=4)
        ttk.Button(selection, text="Liberar COM", command=self.release_port).grid(row=0, column=7, padx=(6, 0), pady=4)
        ttk.Label(selection, text="Carpeta para 'otros'").grid(row=1, column=0, sticky="w", pady=4)
        ttk.Entry(selection, textvariable=self.custom_dir, width=42).grid(row=1, column=1, columnspan=4, sticky="ew", padx=(5, 0), pady=4)
        ttk.Button(selection, text="Elegir...", command=self.choose_custom_dir).grid(row=1, column=5, padx=(6, 0), pady=4)
        for column in range(1, 6):
            selection.columnconfigure(column, weight=1)

        firmware = ttk.LabelFrame(root, text="2. MicroPython", style="Section.TLabelframe", padding=10)
        firmware.pack(fill="x", pady=(0, 10))
        ttk.Label(firmware, text="Imagen .bin").grid(row=0, column=0, sticky="w", pady=4)
        ttk.Entry(firmware, textvariable=self.firmware).grid(row=0, column=1, columnspan=4, sticky="ew", padx=(5, 0), pady=4)
        ttk.Button(firmware, text="Elegir...", command=self.choose_firmware).grid(row=0, column=5, padx=(6, 0), pady=4)
        ttk.Checkbutton(firmware, text="Actualizar MicroPython (borra la flash)", variable=self.flash_micropython).grid(row=1, column=0, columnspan=4, sticky="w", pady=4)
        ttk.Button(firmware, text="Detectar y verificar", command=self.verify_device, style="Action.TButton").grid(row=1, column=5, padx=(6, 0), pady=4)
        for column in range(1, 5):
            firmware.columnconfigure(column, weight=1)

        config = ttk.LabelFrame(root, text="3. Configuración del dispositivo", style="Section.TLabelframe", padding=10)
        config.pack(fill="x", pady=(0, 10))
        self._entry(config, "Wi-Fi", self.wifi_ssid, 0, 0)
        self._entry(config, "Contraseña Wi-Fi", self.wifi_password, 0, 2, show="*")
        self._entry(config, "API URL", self.api_url, 1, 0)
        self._entry(config, "Device ID (MAC)", self.device_id, 2, 0, state="readonly")
        self._entry(config, "MAC (12 hex)", self.device_mac, 3, 0)
        ttk.Button(config, text="Calcular codigo", command=self.calculate_device_code).grid(row=3, column=2, sticky="w", padx=(18, 0), pady=4)
        self._entry(config, "Codigo unico (registrar en cloud)", self.device_code, 5, 0, state="readonly")
        ttk.Button(config, text="Copiar codigo", command=self.copy_device_code).grid(row=5, column=2, sticky="w", padx=(18, 0), pady=4)
        ttk.Checkbutton(config, text="Comandos habilitados", variable=self.commands).grid(row=2, column=2, sticky="w", padx=(5, 0), pady=4)
        self.ga25_widgets = [ttk.Label(config, text="Recorrido GA25 (ms)")]
        self.ga25_widgets[0].grid(row=4, column=0, sticky="w", pady=4)
        self.ga25_widgets.append(ttk.Spinbox(config, from_=1000, to=120000, textvariable=self.full_travel, width=12))
        self.ga25_widgets[1].grid(row=4, column=1, sticky="w", padx=(5, 0), pady=4)
        self.ga25_widgets.append(ttk.Checkbutton(config, text="Invertir sentido GA25", variable=self.reversed))
        self.ga25_widgets[2].grid(row=4, column=2, sticky="w", padx=(5, 0), pady=4)
        self.tenstar_widgets = []
        ttk.Label(config, text="Pulsos por vuelta (Tenstar)").grid(row=6, column=0, sticky="w", pady=4)
        self.tenstar_widgets.extend([config.grid_slaves(row=6, column=0)[0]])
        pulses_widget = ttk.Spinbox(config, from_=1, to=100000, textvariable=self.pulses_per_revolution, width=12)
        pulses_widget.grid(row=6, column=1, sticky="w", padx=(5, 0), pady=4)
        self.tenstar_widgets.append(pulses_widget)
        ttk.Label(config, text="PWM minimo % (Tenstar)").grid(row=6, column=2, sticky="w", padx=(18, 0), pady=4)
        self.tenstar_widgets.extend([config.grid_slaves(row=6, column=2)[0]])
        speed_widget = ttk.Spinbox(config, from_=20, to=35, textvariable=self.tenstar_minimum_speed, width=12)
        speed_widget.grid(row=6, column=3, sticky="w", padx=(5, 0), pady=4)
        self.tenstar_widgets.append(speed_widget)
        for column in (1, 3):
            config.columnconfigure(column, weight=1)

        options = ttk.Frame(root)
        options.pack(fill="x", pady=(0, 8))
        ttk.Checkbutton(options, text="Limpiar archivos del otro perfil", variable=self.clean_files).pack(side="left")
        ttk.Button(options, text="VERIFICAR Y CARGAR", command=self.burn, style="Action.TButton").pack(side="right")

        log_frame = ttk.LabelFrame(root, text="Registro", style="Section.TLabelframe", padding=8)
        log_frame.pack(fill="both", expand=True)
        self.log = tk.Text(log_frame, height=12, wrap="word", state="disabled", background="#101820", foreground="#d7e5e8", insertbackground="white")
        scrollbar = ttk.Scrollbar(log_frame, orient="vertical", command=self.log.yview)
        self.log.configure(yscrollcommand=scrollbar.set)
        self.log.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        ttk.Label(root, textvariable=self.status).pack(anchor="w", pady=(8, 0))

    def _field(self, parent, label, variable, values, row, callback=None):
        ttk.Label(parent, text=label).grid(row=row, column=0 if row == 0 else 0, sticky="w", pady=4)
        box = ttk.Combobox(parent, textvariable=variable, values=values, state="readonly", width=18)
        box.grid(row=row, column=1, sticky="ew", padx=(5, 0), pady=4)
        if callback:
            box.bind("<<ComboboxSelected>>", callback)

    def _entry(self, parent, label, variable, row, column, show=None, state="normal"):
        ttk.Label(parent, text=label).grid(row=row, column=column, sticky="w", pady=4, padx=(0 if column == 0 else 18, 0))
        entry = ttk.Entry(parent, textvariable=variable, show=show, state=state)
        entry.grid(row=row, column=column + 1, sticky="ew", padx=(5, 0), pady=4)

    def copy_device_code(self):
        code = self.device_code.get().strip()
        if not code:
            messagebox.showinfo("Quemador", "Escribe una MAC y pulsa Calcular codigo.")
            return
        self.clipboard_clear()
        self.clipboard_append(code)
        self.status.set("Codigo unico copiado; registralo en cloud junto con el Device ID.")

    def calculate_device_code(self):
        try:
            mac = normalize_mac_address(self.device_mac.get())
            code = device_code_from_mac(mac)
        except BurnerError as error:
            messagebox.showerror("Quemador", str(error))
            return
        self.device_mac.set(mac)
        self.device_id.set("PULSE_{}".format(mac))
        self.device_code.set(code)
        self.status.set("Codigo unico calculado para la MAC {}.".format(mac))

    def _model_changed(self, _event=None):
        if self.model.get() != "otros":
            profile = MODEL_PROFILES[self.model.get()]
            if not self.custom_dir.get():
                self.custom_dir.set(str(profile["directory"]))
        self._log("Perfil seleccionado: {}".format(self.model.get()))
        tenstar = self.model.get() == "tenstar"
        ga25 = self.model.get() == "ga25"
        for widget in getattr(self, "ga25_widgets", ()):
            if ga25:
                widget.grid()
            else:
                widget.grid_remove()
        for widget in getattr(self, "tenstar_widgets", ()):
            if tenstar:
                widget.grid()
            else:
                widget.grid_remove()
        if tenstar:
            self.esp_type.set("ESP32-C3")

    def choose_custom_dir(self):
        directory = filedialog.askdirectory(initialdir=str(ROOT))
        if directory:
            self.custom_dir.set(directory)
            self.model.set("otros")

    def choose_firmware(self):
        path = filedialog.askopenfilename(filetypes=[("Firmware MicroPython", "*.bin"), ("Todos los archivos", "*.*")])
        if path:
            self.firmware.set(path)

    def refresh_ports(self):
        if list_ports is None:
            self.port_box["values"] = ("Instala pyserial",)
            self.port.set("Instala pyserial")
            return
        ports = [port.device for port in list_ports.comports()]
        self.port_box["values"] = ports
        if ports and self.port.get() not in ports:
            self.port.set(ports[0])
        elif not ports:
            self.port.set("")
        self._log("Puertos detectados: {}".format(", ".join(ports) or "ninguno"))

    def release_port(self):
        try:
            port = self._require_port()
        except BurnerError as error:
            messagebox.showerror("Quemador", str(error))
            return
        with self.process_lock:
            processes = list(self.child_processes)
        stopped = 0
        for process in processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                stopped += 1
        if stopped:
            self._log("Procesos del quemador detenidos: {}".format(stopped))
        if serial is None:
            messagebox.showwarning("Quemador", "pyserial no está disponible para comprobar el puerto.")
            return
        probe_code = (
            "import serial; "
            "connection = serial.Serial({!r}, timeout=0.2, write_timeout=0.2); "
            "connection.close(); print('free')"
        ).format(port)
        probe = None
        try:
            python_executable = str(VENV_PYTHON if VENV_PYTHON.is_file() else Path(sys.executable))
            probe = subprocess.Popen([python_executable, "-c", probe_code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            stdout, stderr = probe.communicate(timeout=3)
            if probe.returncode != 0:
                raise serial.SerialException((stderr or stdout).strip() or "Windows rechazó el puerto")
            self._log("{} está libre.".format(port))
            self.status.set("{} está libre".format(port))
            messagebox.showinfo("Quemador", "{} está libre y listo para usar.".format(port))
        except subprocess.TimeoutExpired:
            if probe:
                probe.kill()
                probe.communicate()
            error = "El driver serial no respondió en 3 segundos"
            self._log("{} sigue ocupado: {}".format(port, error))
            self.status.set("{} sigue ocupado por otra aplicación".format(port))
            messagebox.showwarning("Quemador", "{} sigue ocupado o su driver está bloqueado. Cierra la aplicación serial y desconecta/reconecta el USB.".format(port))
        except serial.SerialException as error:
            self._log("{} sigue ocupado: {}".format(port, error))
            self.status.set("{} sigue ocupado por otra aplicación".format(port))
            messagebox.showwarning("Quemador", "{} sigue ocupado. Cierra Thonny, Arduino IDE, otro monitor serial o cualquier proceso que use ese COM.\n\n{}".format(port, error))

    def verify_device(self):
        if self.running:
            return
        try:
            port = self._require_port()
        except BurnerError as error:
            messagebox.showerror("Quemador", str(error))
            return
        self._start_worker("Verificando dispositivo", self._verify_worker, port)

    def burn(self):
        if self.running:
            return
        try:
            port = self._require_port()
            files = self._profile_files()
            if not files:
                raise BurnerError("No se encontraron archivos .py para cargar")
            if self.flash_micropython.get() and not self.firmware.get().strip():
                raise BurnerError("Selecciona una imagen .bin de MicroPython")
            settings = self._settings_snapshot()
            if not settings["api_url"].startswith("https://"):
                raise BurnerError("La URL cloud debe usar HTTPS")
        except BurnerError as error:
            messagebox.showerror("Quemador", str(error))
            return
        self._start_worker("Preparando carga", self._burn_worker, port, files, settings)

    def _settings_snapshot(self):
        return {
            "model": self.model.get(),
            "esp_type": self.esp_type.get(),
            "firmware": self.firmware.get().strip(),
            "flash_micropython": self.flash_micropython.get(),
            "clean_files": self.clean_files.get(),
            "api_url": self.api_url.get().strip().rstrip("/"),
            "device_id": self.device_id.get().strip(),
            "mac": self.device_mac.get().strip(),
            "device_code": self.device_code.get().strip(),
            "ssid": self.wifi_ssid.get(),
            "password": self.wifi_password.get(),
            "full_travel": self.full_travel.get(),
            "pulses_per_revolution": self.pulses_per_revolution.get(),
            "tenstar_minimum_speed": self.tenstar_minimum_speed.get(),
            "reversed": self.reversed.get(),
            "commands": self.commands.get(),
        }

    def _require_port(self):
        port = self.port.get().strip()
        if not port or port == "Instala pyserial":
            raise BurnerError("Selecciona un puerto COM")
        return port

    def _profile_files(self):
        model = self.model.get()
        if model == "otros":
            directory = Path(self.custom_dir.get().strip())
            if not directory.is_dir():
                raise BurnerError("Selecciona una carpeta válida para el modelo 'otros'")
            return [(path.name, path) for path in sorted(directory.glob("*.py")) if path.name not in {"config.py", "wifi_config.py", "pulsegrid_config.py"}]
        profile = MODEL_PROFILES[model]
        sources = profile.get("sources", {})
        paths = [(name, sources.get(name, profile["directory"] / name)) for name in profile["files"]]
        missing = [name for name, path in paths if not path.is_file()]
        if missing:
            raise BurnerError("Faltan archivos del perfil {}: {}".format(profile["label"], ", ".join(missing)))
        return paths

    def _verify_worker(self, port):
        self._log("Verificando chip en {}...".format(port))
        chip = self._run_tool(["esptool", "--port", port, "chip-id"], allow_error=True)
        self._log(chip.output)
        runtime = self._run_tool(["mpremote", "connect", port, "exec", "import sys; print(sys.implementation); print(sys.version)"], allow_error=True)
        self._log(runtime.output)
        if chip.code != 0:
            self._log("No se pudo leer el chip. Comprueba que el puerto no esté ocupado.")
        if runtime.code != 0:
            self._log("No se pudo consultar MicroPython; puede ser una placa virgen o estar ejecutando otro firmware.")
        self._finish("Verificación terminada")

    def _burn_worker(self, port, files, settings):
        self._log("Perfil: {} | Chip seleccionado: {}".format(settings["model"], settings["esp_type"]))
        self._log("Archivos: {}".format(", ".join(name for name, _ in files)))
        if settings["flash_micropython"]:
            chip = self._run_tool(["esptool", "--port", port, "chip-id"])
            self._log(chip.output)
            self._validate_chip(chip.output, settings["esp_type"])
            image = Path(settings["firmware"])
            if not image.is_file():
                raise BurnerError("La imagen MicroPython no existe")
            self._log("Borrando flash...")
            self._run_tool(["esptool", "--port", port, "erase_flash"])
            self._log("Escribiendo MicroPython: {}".format(image.name))
            self._run_tool(["esptool", "--port", port, "write_flash", "-z", "0x1000", str(image)])
            self._log("MicroPython instalado. Esperando reinicio...")
            time.sleep(2)
        else:
            self._log("Usando el MicroPython existente; no se usara esptool ni se borrara la flash.")
            runtime = self._run_tool(["mpremote", "connect", port, "exec", "import sys; print(sys.version)"])
            self._log("MicroPython detectado:\n" + runtime.output)
        if settings["model"] in MODEL_PROFILES:
            settings["device_id"] = self._device_id_from_mac(port)
            self.events.put(("device-id", settings["device_id"]))
            self._log("Device ID asignado: {}".format(settings["device_id"]))
            mac = settings["device_id"].removeprefix("PULSE_")
            if settings["mac"] and normalize_mac_address(settings["mac"]) != mac:
                raise BurnerError("La MAC introducida no coincide con la MAC leida de la placa ({})".format(mac))
            settings["mac"] = mac
            settings["device_code"] = device_code_from_mac(mac)
        self._upload_profile(port, files, settings)
        if settings["model"] in MODEL_PROFILES:
            self._log("Reiniciando la placa; el firmware toma el REPL durante su ejecucion.")
            self._run_tool(["mpremote", "connect", port, "reset"])
            self._log("CODIGO UNICO DEL DISPOSITIVO: {}".format(settings["device_code"]))
            self.events.put(("device-code", settings["device_code"]))
        else:
            if not settings["flash_micropython"]:
                self._log("Reiniciando MicroPython...")
                self._run_tool(["mpremote", "connect", port, "soft-reset"])
            self._verify_runtime(port)
        self._finish("Carga terminada correctamente")

    def _validate_chip(self, output, selected):
        if selected != "Auto" and selected.lower() not in output.lower():
            raise BurnerError("El chip detectado no coincide con {}. Revisa el tipo de ESP32 o usa Auto.".format(selected))

    def _device_id_from_mac(self, port):
        result = self._run_mpremote(port, [
            "exec",
            "import network; w=network.WLAN(network.STA_IF); w.active(True); print('PULSE_' + ''.join('{:02X}'.format(x) for x in w.config('mac'))) ",
        ])
        match = re.search(r"PULSE_([0-9A-Fa-f]{12})", result.output)
        if not match:
            raise BurnerError("No se pudo leer la MAC de la ESP32 para asignar el Device ID")
        return "PULSE_{}".format(match.group(1).upper())

    def _upload_profile(self, port, files, settings):
        model = settings["model"]
        generated = self._make_config(model, settings)
        upload = list(files) + generated
        if settings["clean_files"]:
            stale = MODEL_PROFILES.get(model, {}).get("remove", ())
            for name in stale:
                self._run_tool(["mpremote", "connect", port, "fs", "rm", ":" + name], allow_error=True)
        for name, path in upload:
            self._log("Cargando {}...".format(name))
            self._run_mpremote(port, ["fs", "cp", str(path), ":" + name])
        self._log("Archivos cargados. Configuración: {}".format(", ".join(name for name, _ in generated) or "ninguna"))

    def _run_mpremote(self, port, arguments):
        command = ["mpremote", "connect", port] + list(arguments)
        transient_errors = ("could not enter raw repl", "could not exec command", "device is busy or does not respond")
        last_result = None
        for attempt in range(1, MPREMOTE_RETRY_ATTEMPTS + 1):
            result = self._run_tool(command, allow_error=True)
            if result.code == 0:
                return result
            last_result = result
            output = result.output.casefold()
            if not any(marker in output for marker in transient_errors):
                break
            if attempt < MPREMOTE_RETRY_ATTEMPTS:
                self._log("MicroPython aún está iniciando en {}; reintentando acceso serial ({}/{}).".format(
                    port, attempt + 1, MPREMOTE_RETRY_ATTEMPTS))
                time.sleep(MPREMOTE_RETRY_DELAY_SECONDS)
        raise BurnerError((last_result.output if last_result else "No se pudo ejecutar mpremote") or "No se pudo ejecutar mpremote")

    def _make_config(self, model, settings):
        if model == "otros":
            return []
        values = {
            "api_url": settings["api_url"],
            "device_code": settings["device_code"],
            "device_id": settings["device_id"],
            "ssid": settings["ssid"],
            "password": settings["password"],
        }
        descriptor, temporary_name = tempfile.mkstemp(prefix="pulsegrid_", suffix=".py")
        os.close(descriptor)
        temporary = Path(temporary_name)
        self.temp_files.append(temporary)
        if model == "servo":
            content = ("WIFI_SSID = {!r}\nWIFI_PASSWORD = {!r}\nAPI_URL = {!r}\nDEVICE_CODE = {!r}\n"
                       "DEVICE_ID = {!r}\nCOMMANDS_ENABLED = {!r}\nDIRECTION_REVERSED = {!r}\n").format(
                           values["ssid"], values["password"], values["api_url"], values["device_code"],
                           values["device_id"], settings["commands"], settings["reversed"])
            temporary.write_text(content, encoding="ascii")
            return [("config.py", temporary)]
        if model == "tenstar":
            pulses = int(settings["pulses_per_revolution"])
            minimum_speed = int(settings["tenstar_minimum_speed"])
            if pulses <= 0 or not 20 <= minimum_speed <= 35:
                raise BurnerError("Tenstar requiere pulsos por vuelta > 0 y PWM minimo entre 20 y 35%")
            content = ("WIFI_SSID = {!r}\nWIFI_PASSWORD = {!r}\nAPI_URL = {!r}\nDEVICE_CODE = {!r}\n"
                       "DEVICE_ID = {!r}\nPULSES_PER_REVOLUTION = {}\nMINIMUM_SPEED_PCT = {}\nCOMMANDS_ENABLED = {!r}\n").format(
                           values["ssid"], values["password"], values["api_url"], values["device_code"],
                           values["device_id"], pulses, minimum_speed, settings["commands"])
            temporary.write_text(content, encoding="ascii")
            return [("config.py", temporary)]
        content = ("WIFI_SSID = {!r}\nWIFI_PASSWORD = {!r}\nAPI_URL = {!r}\nDEVICE_CODE = {!r}\n"
                   "DEVICE_ID = {!r}\nFULL_TRAVEL_MS = {}\nOPEN_A_LEVEL = 1\nDIRECTION_REVERSED = {!r}\n").format(
                       values["ssid"], values["password"], values["api_url"], values["device_code"], values["device_id"], settings["full_travel"], settings["reversed"])
        temporary.write_text(content, encoding="ascii")
        return [("config.py", temporary)]

    def _verify_runtime(self, port):
        result = self._run_tool(["mpremote", "connect", port, "exec", "import sys; print(sys.version)"], allow_error=True)
        self._log("MicroPython después de la carga:\n" + result.output)
        if result.code != 0:
            raise BurnerError("No se pudo verificar MicroPython después de la carga")

    def _run_tool(self, args, allow_error=False):
        tool = args[0]
        python_executable = str(VENV_PYTHON if VENV_PYTHON.is_file() else Path(sys.executable))
        commands = [[python_executable, "-m", tool] + args[1:]]
        last_error = ""
        for command in commands:
            process = None
            try:
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                with self.process_lock:
                    self.child_processes.add(process)
                stdout, stderr = process.communicate(timeout=180)
                returncode = process.returncode
            except FileNotFoundError as error:
                last_error = "No se encontro {}. Ejecuta run_quemador.bat para instalar las dependencias.".format(tool)
                continue
            except subprocess.TimeoutExpired:
                if process:
                    process.kill()
                    process.communicate()
                raise BurnerError("{} tardó demasiado y fue detenido. Usa Liberar COM antes de intentar de nuevo.".format(tool))
            finally:
                if process:
                    with self.process_lock:
                        self.child_processes.discard(process)
            output = ((stdout or "") + (stderr or "")).strip()
            if returncode == 0 or allow_error:
                return ToolResult(returncode, output)
            if "No module named" in output or "ModuleNotFoundError" in output:
                last_error = "Falta {} en {}. Ejecuta run_quemador.bat para instalar las dependencias.".format(tool, python_executable)
            else:
                last_error = output
        if allow_error:
            return ToolResult(1, last_error or "Herramienta no encontrada")
        raise BurnerError(last_error or "No se pudo ejecutar la herramienta")

    def _start_worker(self, label, function, *args):
        self.running = True
        self.status.set(label + "...")
        self._log(label + "...")
        threading.Thread(target=self._worker_wrapper, args=(function, args), daemon=True).start()

    def _worker_wrapper(self, function, args):
        try:
            function(*args)
        except Exception as error:
            self.events.put(("error", str(error)))

    def _finish(self, message):
        self.events.put(("done", message))

    def _drain_events(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "log":
                    self._write_log(value)
                elif kind == "done":
                    self.running = False
                    self.status.set(value)
                    self._write_log(value)
                elif kind == "device-id":
                    self.device_id.set(value)
                elif kind == "device-code":
                    self.device_code.set(value)
                elif kind == "error":
                    self.running = False
                    self.status.set("Error")
                    self._write_log("ERROR: " + value)
                    messagebox.showerror("Quemador", value)
        except queue.Empty:
            pass
        self.after(100, self._drain_events)

    def _log(self, message):
        self.events.put(("log", str(message)))

    def _write_log(self, message):
        self.log.configure(state="normal")
        self.log.insert("end", message + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def destroy(self):
        for path in self.temp_files:
            try:
                path.unlink()
            except OSError:
                pass
        super().destroy()


class ToolResult:
    def __init__(self, code, output):
        self.code = code
        self.output = output


if __name__ == "__main__":
    BurnerApp().mainloop()
