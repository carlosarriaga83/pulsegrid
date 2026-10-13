import ast
import json
import math
import queue
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.parse
import urllib.request
from tkinter import messagebox, ttk

import serial


DEFAULT_PORT = "COM6"
MIN_POSITION = 300
MAX_POSITION = 3700
MODES = {"Servo": 0, "Rueda": 1, "Multivuelta": 3}
MULTITURN_LIMIT = 999.99
COUNTS_PER_TURN = 4096
MAX_SPEED = 3073
MAX_ACCELERATION = 150


class ToolTip:
    def __init__(self, widget, text):
        self.widget = widget
        self.text = text
        self.window = None
        widget.bind("<Enter>", self._show)
        widget.bind("<Leave>", self._hide)

    def _show(self, _event=None):
        if self.window:
            return
        x = self.widget.winfo_rootx() + 12
        y = self.widget.winfo_rooty() + self.widget.winfo_height() + 4
        self.window = tk.Toplevel(self.widget)
        self.window.wm_overrideredirect(True)
        self.window.wm_geometry("+{}+{}".format(x, y))
        tk.Label(self.window, text=self.text, background="#fff6c7", relief="solid", borderwidth=1,
                 padx=6, pady=3, font=("Segoe UI", 9)).pack()

    def _hide(self, _event=None):
        if self.window:
            self.window.destroy()
            self.window = None


class TestPanel(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Panel de pruebas - Cortina ESP32")
        self.geometry("1120x720")
        self.minsize(920, 620)
        self.results = queue.Queue()
        self.absolute_results = queue.Queue()
        self.busy = False
        self.absolute_polling = False
        self.serial_conn = None
        self.serial_lock = threading.Lock()
        self.port = tk.StringVar(value=DEFAULT_PORT)
        self.web_url = tk.StringVar(value="http://192.168.86.207")
        self.use_web = tk.BooleanVar(value=False)
        self.wifi_ssid = tk.StringVar(value="8a")
        self.wifi_password = tk.StringVar(value="12345678a")
        self.blind_servo_id = tk.IntVar(value=1)
        self.blind_rolled_turns = tk.DoubleVar(value=0.0)
        self.blind_unrolled_turns = tk.DoubleVar(value=10.0)
        self.blind_percent = tk.DoubleVar(value=0.0)
        self.blind_actual_percent = 0.0
        self.blind_editing = False
        self.position = tk.IntVar(value=2000)
        self.servo_id = tk.IntVar(value=1)
        self.new_id = tk.IntVar(value=1)
        self.min_angle = tk.IntVar(value=300)
        self.max_angle = tk.IntVar(value=3700)
        self.mode = tk.StringVar(value="Servo")
        self.torque_limit = tk.IntVar(value=1000)
        self.speed = tk.IntVar(value=800)
        self.acceleration = tk.IntVar(value=50)
        self.command_mode = tk.StringVar(value="Servo")
        self.command_servo_id = tk.IntVar(value=1)
        self.command_position = tk.IntVar(value=2000)
        self.command_turns = tk.DoubleVar(value=1.0)
        self.servo_command_positions = {1: tk.IntVar(value=2000), 2: tk.IntVar(value=2000)}
        self.servo_command_modes = {1: tk.StringVar(value="Servo"), 2: tk.StringVar(value="Servo")}
        self.servo_command_turns = {1: tk.DoubleVar(value=1.0), 2: tk.DoubleVar(value=1.0)}
        self.servo_command_speeds = {1: tk.IntVar(value=300), 2: tk.IntVar(value=300)}
        self.servo_command_servo_speeds = {1: tk.IntVar(value=800), 2: tk.IntVar(value=800)}
        self.servo_command_multiturn_speeds = {1: tk.IntVar(value=800), 2: tk.IntVar(value=800)}
        self.servo_command_servo_accelerations = {1: tk.IntVar(value=50), 2: tk.IntVar(value=50)}
        self.servo_command_wheel_accelerations = {1: tk.IntVar(value=50), 2: tk.IntVar(value=50)}
        self.servo_command_multiturn_accelerations = {1: tk.IntVar(value=50), 2: tk.IntVar(value=50)}
        self.servo_visuals = {}
        self.servo_status_labels = {}
        self.visual_positions = {1: 2000.0, 2: 2000.0}
        self.visual_targets = {1: 2000.0, 2: 2000.0}
        self.servo_state = {
            servo_id: {
                "mode": 0,
                "min_angle": MIN_POSITION,
                "max_angle": MAX_POSITION,
                "torque_limit": 1000,
                "torque_enabled": None,
                "turns": 0.0,
                "remaining_turns": 0.0,
            }
            for servo_id in (1, 2)
        }
        self.motion_speed = 800
        self.motion_acceleration = 50
        self.status = tk.StringVar(value="Listo. Ningun movimiento se ejecuta al abrir el panel.")
        self._configure_styles()
        self._build_ui()
        self._animate_visuals()
        self.after(100, self._poll_results)
        self.after(150, self._poll_absolute_results)
        self.after(500, self._poll_absolute_turns)
        self.protocol("WM_DELETE_WINDOW", self.close)

    def _build_ui(self):
        frame = ttk.Frame(self, padding=16)
        frame.pack(fill="both", expand=True)

        connection = ttk.LabelFrame(frame, text="Conexion", padding=10)
        connection.pack(fill="x")
        ttk.Label(connection, text="Puerto:").grid(row=0, column=0, sticky="w")
        port_input = ttk.Entry(connection, textvariable=self.port, width=10)
        port_input.grid(row=0, column=1, padx=8, sticky="w")
        ToolTip(port_input, "Puerto serie de la ESP32, por ejemplo COM6.")
        ttk.Checkbutton(connection, text="Usar interfaz web", variable=self.use_web).grid(row=0, column=2, padx=8, sticky="w")
        ttk.Label(connection, text="IP web:").grid(row=0, column=3, sticky="e")
        web_input = ttk.Entry(connection, textvariable=self.web_url, width=22)
        web_input.grid(row=0, column=4, padx=8, sticky="w")
        ToolTip(web_input, "Direccion HTTP de la ESP32. Activalo para usar GUI de PC y web a la vez.")
        self.status_button = ttk.Button(connection, text="Leer estado", command=self.read_status)
        self.status_button.grid(row=0, column=5, padx=4)
        self.scan_button = ttk.Button(connection, text="Escanear servos", command=self.scan_servos)
        self.scan_button.grid(row=0, column=6, padx=4)

        notebook = ttk.Notebook(frame)
        notebook.pack(fill="both", expand=True, pady=(12, 0))
        notebook.configure(width=880, height=500)

        control_tab = ttk.Frame(notebook, padding=12)
        config_tab = ttk.Frame(notebook, padding=12)
        monitor_tab = ttk.Frame(notebook, padding=12)
        wifi_tab = ttk.Frame(notebook, padding=12)
        blind_tab = ttk.Frame(notebook, padding=12)
        notebook.add(control_tab, text="Control")
        notebook.add(config_tab, text="Configuracion")
        notebook.add(monitor_tab, text="Monitor")
        notebook.add(wifi_tab, text="Wi-Fi")
        notebook.add(blind_tab, text="Persiana")
        control_tab.columnconfigure(0, weight=1)
        config_tab.columnconfigure(0, weight=1)
        monitor_tab.columnconfigure(0, weight=1)
        monitor_tab.rowconfigure(0, weight=1)
        wifi_tab.columnconfigure(0, weight=1)
        blind_tab.columnconfigure(0, weight=1)

        blind_config = ttk.LabelFrame(blind_tab, text="Persiana vertical", padding=12)
        blind_config.pack(fill="x")
        ttk.Label(blind_config, text="Servo:").grid(row=0, column=0, sticky="w")
        blind_servo = ttk.Spinbox(blind_config, from_=1, to=2, textvariable=self.blind_servo_id, width=7)
        blind_servo.grid(row=0, column=1, padx=8, sticky="w")
        ttk.Label(blind_config, text="Vueltas enrollada:").grid(row=0, column=2, sticky="e")
        ttk.Spinbox(blind_config, from_=-999.99, to=999.99, increment=0.01, textvariable=self.blind_rolled_turns, width=10).grid(row=0, column=3, padx=8, sticky="w")
        ttk.Label(blind_config, text="Vueltas desenrollada:").grid(row=1, column=0, sticky="w", pady=8)
        ttk.Spinbox(blind_config, from_=-999.99, to=999.99, increment=0.01, textvariable=self.blind_unrolled_turns, width=10).grid(row=1, column=1, padx=8, sticky="w")
        ttk.Button(blind_config, text="Guardar extremos", command=self.save_blind_configuration).grid(row=1, column=2, padx=8, sticky="w")
        blind_config.columnconfigure(3, weight=1)
        blind_control = ttk.LabelFrame(blind_tab, text="Posicion deseada", padding=12)
        blind_control.pack(fill="x", pady=(12, 0))
        self.blind_slider = ttk.Scale(
            blind_control,
            from_=0,
            to=100,
            orient="vertical",
            length=220,
            variable=self.blind_percent,
            command=self._preview_blind,
        )
        self.blind_slider.grid(row=0, column=0, rowspan=2, sticky="ns", padx=(8, 18))
        self.blind_slider.bind("<ButtonPress-1>", self._begin_blind_edit)
        self.blind_slider.bind("<ButtonRelease-1>", self._end_blind_edit)
        self.blind_position_label = ttk.Label(blind_control, text="0% enrollada", width=22)
        self.blind_position_label.grid(row=0, column=1, sticky="sw")
        ttk.Button(blind_control, text="Mover persiana", command=self.move_blind).grid(row=1, column=1, sticky="sw", pady=(12, 0))
        self.blind_canvas = tk.Canvas(blind_tab, height=260, background="#dce7eb", highlightthickness=0)
        self.blind_canvas.pack(fill="x", pady=(12, 0))
        self._draw_blind(0.0)

        visual_frame = ttk.LabelFrame(control_tab, text="Representacion de servos", padding=8)
        visual_frame.pack(fill="x", pady=(0, 12))
        for servo_id in (1, 2):
            servo_panel = ttk.Frame(visual_frame)
            servo_panel.grid(row=0, column=servo_id - 1, padx=12, sticky="nsew")
            visual_frame.columnconfigure(servo_id - 1, weight=1)
            ttk.Label(servo_panel, text="Servo {}".format(servo_id)).pack()
            canvas = tk.Canvas(servo_panel, width=260, height=115, background="#17202b", highlightthickness=0)
            canvas.pack(fill="x", expand=True, pady=(4, 0))
            self.servo_visuals[servo_id] = canvas
            self._draw_servo(servo_id)
            state_label = ttk.Label(servo_panel, text="Estado real: sin leer", anchor="w", wraplength=470)
            state_label.pack(fill="x", pady=(3, 0))
            self.servo_status_labels[servo_id] = state_label
            servo_commands = ttk.Frame(servo_panel)
            servo_commands.pack(fill="x", pady=(6, 0))
            for column, width in enumerate((12, 10, 10, 10, 11, 9)):
                servo_commands.columnconfigure(column, minsize=width * 8)
            headers = ("Modo", "Valor", "Velocidad", "Aceleración", "Ejecutar", "Parar")
            for column, header in enumerate(headers):
                ttk.Label(servo_commands, text=header, anchor="center").grid(
                    row=0, column=column, padx=2, pady=(0, 3), sticky="ew"
                )

            servo_label = ttk.Label(servo_commands, text="Servo", anchor="w")
            servo_label.grid(row=1, column=0, padx=2, pady=2, sticky="w")
            ToolTip(servo_label, "Modo Servo: posicion angular absoluta entre 0 y 4095.")
            position_control = ttk.Spinbox(
                servo_commands,
                from_=0,
                to=4095,
                textvariable=self.servo_command_positions[servo_id],
                width=8,
            )
            position_control.grid(row=1, column=1, padx=2, pady=2, sticky="ew")
            ToolTip(position_control, "Posicion angular del servo {}: minimo 0, maximo 4095.".format(servo_id))
            servo_speed_control = ttk.Spinbox(
                servo_commands,
                from_=0,
                to=MAX_SPEED,
                textvariable=self.servo_command_servo_speeds[servo_id],
                width=7,
            )
            servo_speed_control.grid(row=1, column=2, padx=2, pady=2, sticky="ew")
            ToolTip(servo_speed_control, "Velocidad del modo Servo: minimo 0, maximo 3073 pasos/segundo.")
            servo_acceleration_control = ttk.Spinbox(
                servo_commands,
                from_=0,
                to=MAX_ACCELERATION,
                textvariable=self.servo_command_servo_accelerations[servo_id],
                width=7,
            )
            servo_acceleration_control.grid(row=1, column=3, padx=2, pady=2, sticky="ew")
            ToolTip(servo_acceleration_control, "Aceleracion del modo Servo: minimo 0, maximo 150.")
            ttk.Button(
                servo_commands,
                text="Mover",
                command=lambda current_id=servo_id: self.execute_visual_mode(current_id, "Servo"),
            ).grid(row=1, column=4, padx=2, pady=2, sticky="ew")
            ttk.Button(
                servo_commands,
                text="Parar",
                command=lambda current_id=servo_id: self.stop_visual_servo(current_id),
            ).grid(row=1, column=5, padx=2, pady=2, sticky="ew")

            wheel_label = ttk.Label(servo_commands, text="Rueda", anchor="w")
            wheel_label.grid(row=2, column=0, padx=2, pady=2, sticky="w")
            ToolTip(wheel_label, "Modo Rueda: giro continuo. Usa velocidad positiva o negativa para elegir la direccion.")
            speed_control = ttk.Spinbox(
                servo_commands,
                from_=-MAX_SPEED,
                to=MAX_SPEED,
                textvariable=self.servo_command_speeds[servo_id],
                width=8,
            )
            speed_control.grid(row=2, column=1, padx=2, pady=2, sticky="ew")
            ToolTip(speed_control, "Velocidad de rueda: minimo -3073, maximo 3073 pasos/segundo. El signo indica la direccion.")
            ttk.Label(servo_commands, text="--", anchor="center").grid(row=2, column=2, padx=2, pady=2, sticky="ew")
            wheel_acceleration_control = ttk.Spinbox(
                servo_commands,
                from_=0,
                to=MAX_ACCELERATION,
                textvariable=self.servo_command_wheel_accelerations[servo_id],
                width=7,
            )
            wheel_acceleration_control.grid(row=2, column=3, padx=2, pady=2, sticky="ew")
            ToolTip(wheel_acceleration_control, "Aceleracion del modo Rueda: minimo 0, maximo 150.")
            ttk.Button(
                servo_commands,
                text="Girar",
                command=lambda current_id=servo_id: self.execute_visual_mode(current_id, "Rueda"),
            ).grid(row=2, column=4, padx=2, pady=2, sticky="ew")
            ttk.Button(
                servo_commands,
                text="Parar",
                command=lambda current_id=servo_id: self.stop_visual_servo(current_id),
            ).grid(row=2, column=5, padx=2, pady=2, sticky="ew")

            multiturn_label = ttk.Label(servo_commands, text="Multivuelta", anchor="w")
            multiturn_label.grid(row=3, column=0, padx=2, pady=2, sticky="w")
            ToolTip(multiturn_label, "Modo Multivuelta: mueve hasta 999.99 vueltas usando el encoder como contador absoluto.")
            turns_control = ttk.Spinbox(
                servo_commands,
                from_=-MULTITURN_LIMIT,
                to=MULTITURN_LIMIT,
                increment=0.01,
                textvariable=self.servo_command_turns[servo_id],
                width=5,
            )
            turns_control.grid(row=3, column=1, padx=2, pady=2, sticky="ew")
            ToolTip(turns_control, "Vueltas: minimo -999.99, maximo 999.99; admite fracciones de 0.01. El signo indica la direccion.")
            multiturn_speed_control = ttk.Spinbox(
                servo_commands,
                from_=0,
                to=MAX_SPEED,
                textvariable=self.servo_command_multiturn_speeds[servo_id],
                width=7,
            )
            multiturn_speed_control.grid(row=3, column=2, padx=2, pady=2, sticky="ew")
            ToolTip(multiturn_speed_control, "Velocidad del modo Multivuelta: minimo 0, maximo 3073 pasos/segundo.")
            multiturn_acceleration_control = ttk.Spinbox(
                servo_commands,
                from_=0,
                to=MAX_ACCELERATION,
                textvariable=self.servo_command_multiturn_accelerations[servo_id],
                width=7,
            )
            multiturn_acceleration_control.grid(row=3, column=3, padx=2, pady=2, sticky="ew")
            ToolTip(multiturn_acceleration_control, "Aceleracion del modo Multivuelta: minimo 0, maximo 150.")
            ttk.Button(
                servo_commands,
                text="Girar",
                command=lambda current_id=servo_id: self.execute_visual_mode(current_id, "Multivuelta"),
            ).grid(row=3, column=4, padx=2, pady=2, sticky="ew")
            ttk.Button(
                servo_commands,
                text="Parar",
                command=lambda current_id=servo_id: self.stop_visual_servo(current_id),
            ).grid(row=3, column=5, padx=2, pady=2, sticky="ew")

            torque_row = ttk.Frame(servo_panel)
            torque_row.pack(fill="x", pady=(4, 0))
            ttk.Button(
                torque_row,
                text="Torque ON",
                command=lambda current_id=servo_id: self.set_visual_torque(current_id, True),
            ).pack(side="left", padx=2)
            ttk.Button(
                torque_row,
                text="OFF",
                command=lambda current_id=servo_id: self.set_visual_torque(current_id, False),
            ).pack(side="left", padx=2)
            ttk.Button(
                torque_row,
                text="Parar",
                command=lambda current_id=servo_id: self.stop_visual_servo(current_id),
            ).pack(side="left", padx=2)
            ttk.Button(
                torque_row,
                text="Cero vueltas",
                command=lambda current_id=servo_id: self.reset_visual_turns(current_id),
            ).pack(side="left", padx=2)

        config = ttk.LabelFrame(config_tab, text="Configuracion ST3215", padding=10)
        config.pack(fill="x", pady=(0, 12))
        ttk.Label(config, text="Servo:").grid(row=0, column=0, sticky="w")
        config_servo_input = ttk.Spinbox(config, from_=1, to=2, textvariable=self.servo_id, width=7)
        config_servo_input.grid(row=0, column=1, sticky="w")
        ToolTip(config_servo_input, "Servo cuya configuracion se desea leer o modificar.")
        ttk.Button(config, text="Leer configuracion", command=self.read_configuration).grid(row=0, column=2, padx=8, sticky="w")
        ttk.Label(config, text="ID nuevo:").grid(row=1, column=0, sticky="w", pady=4)
        new_id_input = ttk.Spinbox(config, from_=0, to=253, textvariable=self.new_id, width=7)
        new_id_input.grid(row=1, column=1, sticky="w")
        ToolTip(new_id_input, "Nuevo ID del servo. Usa un valor unico entre 1 y 20.")
        ttk.Label(config, text="Modo:").grid(row=1, column=2, sticky="e")
        config_mode_input = ttk.Combobox(config, textvariable=self.mode, values=tuple(MODES), state="readonly", width=12)
        config_mode_input.grid(row=1, column=3, sticky="w")
        ToolTip(config_mode_input, "Servo: posicion angular 0-4095. Rueda: giro continuo. Multivuelta: hasta +/-7 vueltas. Los limites 300-3700 son la reserva mecanica de este proyecto.")
        ttk.Label(config, text="Limite minimo:").grid(row=2, column=0, sticky="w", pady=4)
        min_input = ttk.Spinbox(config, from_=0, to=4094, textvariable=self.min_angle, width=7)
        min_input.grid(row=2, column=1, sticky="w")
        ToolTip(min_input, "Limite inferior en modo Servo: minimo 0, maximo 4094; debe ser menor que el limite maximo.")
        ttk.Label(config, text="Limite maximo:").grid(row=2, column=2, sticky="e")
        max_input = ttk.Spinbox(config, from_=1, to=4095, textvariable=self.max_angle, width=7)
        max_input.grid(row=2, column=3, sticky="w")
        ToolTip(max_input, "Limite superior en modo Servo: minimo 1, maximo 4095; debe ser mayor que el limite minimo.")
        ttk.Label(config, text="Torque maximo:").grid(row=3, column=0, sticky="w", pady=4)
        torque_input = ttk.Spinbox(config, from_=0, to=1000, textvariable=self.torque_limit, width=7)
        torque_input.grid(row=3, column=1, sticky="w")
        ToolTip(torque_input, "Limite de torque del servo: minimo 0, maximo 1000.")
        ttk.Button(config, text="Aplicar configuracion", command=self.apply_configuration).grid(row=3, column=2, sticky="w", padx=8)
        ttk.Button(config, text="Cambiar ID", command=self.change_id).grid(row=3, column=3, sticky="w")
        ttk.Label(config, text="Velocidad:").grid(row=4, column=0, sticky="w", pady=4)
        speed_input = ttk.Spinbox(config, from_=0, to=MAX_SPEED, textvariable=self.speed, width=7)
        speed_input.grid(row=4, column=1, sticky="w")
        ToolTip(speed_input, "Velocidad general: minimo 0, maximo 3073 pasos/segundo, segun Waveshare.")
        ttk.Label(config, text="Aceleracion:").grid(row=4, column=2, sticky="e")
        acceleration_input = ttk.Spinbox(config, from_=0, to=MAX_ACCELERATION, textvariable=self.acceleration, width=7)
        acceleration_input.grid(row=4, column=3, sticky="w")
        ToolTip(acceleration_input, "Aceleracion: minimo 0, maximo 150; valores menores suavizan el arranque y frenado.")
        ttk.Button(config, text="Aplicar movimiento", command=self.apply_motion).grid(row=5, column=0, columnspan=4, pady=4)

        wifi_config = ttk.LabelFrame(wifi_tab, text="Red Wi-Fi de la ESP32", padding=12)
        wifi_config.pack(fill="x", pady=(0, 12))
        ttk.Label(wifi_config, text="Nombre de red (SSID):").grid(row=0, column=0, sticky="w", pady=4)
        wifi_ssid_input = ttk.Entry(wifi_config, textvariable=self.wifi_ssid, width=30)
        wifi_ssid_input.grid(row=0, column=1, padx=8, sticky="ew")
        ToolTip(wifi_ssid_input, "Nombre exacto de la red a la que se conectara la ESP32.")
        ttk.Label(wifi_config, text="Contraseña:").grid(row=1, column=0, sticky="w", pady=4)
        wifi_password_input = ttk.Entry(wifi_config, textvariable=self.wifi_password, show="*", width=30)
        wifi_password_input.grid(row=1, column=1, padx=8, sticky="ew")
        ToolTip(wifi_password_input, "Contraseña de la red Wi-Fi.")
        ttk.Button(wifi_config, text="Guardar en ESP32", command=self.apply_wifi_configuration).grid(row=0, column=2, padx=8, sticky="w")
        ttk.Button(wifi_config, text="Restaurar valores", command=self.reset_wifi_configuration).grid(row=1, column=2, padx=8, sticky="w")
        wifi_config.columnconfigure(1, weight=1)
        ttk.Label(
            wifi_tab,
            text="La configuracion se guarda en la placa. Pulsa EN despues de guardar para que el servidor web se conecte a la nueva red.",
            wraplength=760,
        ).pack(anchor="w", pady=(4, 0))
    
        log_frame = ttk.LabelFrame(monitor_tab, text="Resultado", padding=8)
        log_frame.pack(fill="both", expand=True)
        self.log = tk.Text(log_frame, height=10, state="disabled", wrap="word")
        self.log.pack(fill="both", expand=True)
        ttk.Label(monitor_tab, textvariable=self.status).pack(anchor="w", pady=(8, 0))
        self._add_button_hints(frame)

    def apply_wifi_configuration(self):
        ssid = self.wifi_ssid.get().strip()
        password = self.wifi_password.get()
        if not ssid:
            messagebox.showerror("Wi-Fi invalido", "Escribe el nombre de la red.")
            return
        if not password:
            messagebox.showerror("Wi-Fi invalido", "Escribe la contraseña de la red.")
            return
        config_text = "WIFI_SSID = {!r}\\nWIFI_PASSWORD = {!r}\\n".format(ssid, password)
        code = "open('wifi_config.py', 'w').write({!r}); import webserver; webserver.WIFI_SSID = {!r}; webserver.WIFI_PASSWORD = {!r}; print('WiFi guardado: ' + webserver.WIFI_SSID)".format(
            config_text, ssid, password
        )
        self.run_remote(code, "Guardando configuracion Wi-Fi")

    def reset_wifi_configuration(self):
        self.wifi_ssid.set("8a")
        self.wifi_password.set("12345678a")

    def _configure_styles(self):
        style = ttk.Style(self)
        style.configure("TNotebook.Tab", padding=(20, 8), font=("Segoe UI", 10, "bold"))
        style.configure("TNotebook", tabmargins=(0, 0, 0, 0))

    def write_log(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text.rstrip() + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def move_to_position(self):
        try:
            target = int(self.position.get())
        except (TypeError, ValueError):
            messagebox.showerror("Posicion invalida", "Escribe un numero entre 300 y 3700.")
            return
        if not MIN_POSITION <= target <= MAX_POSITION:
            messagebox.showerror("Posicion invalida", "Usa un valor entre 300 y 3700.")
            return
        self._set_visual_target(1, target)
        self._set_visual_target(2, target)
        self.run_remote("main.cortina.mover_a({})".format(target), "Moviendo a {}".format(target))

    def move_visual_servo(self, servo_id):
        position = self._value(self.servo_command_positions[servo_id], "posicion del servo {}".format(servo_id))
        speed = self._value(self.speed, "velocidad")
        acceleration = self._value(self.acceleration, "aceleracion")
        if position is None or speed is None or acceleration is None or not 0 <= position <= 4095:
            messagebox.showerror("Comando invalido", "La posicion debe estar entre 0 y 4095.")
            return
        self._update_servo_state(servo_id, mode=MODES["Servo"])
        self._set_visual_target(servo_id, position)
        code = "main.cortina.configure_motion({}, {}); main.cortina.comando(0, position={}, servo_id={})".format(
            speed, acceleration, position, servo_id
        )
        self.run_remote(code, "Moviendo servo {}".format(servo_id))

    def update_visual_command_fields(self, servo_id):
        mode_name = self.servo_command_modes[servo_id].get()
        self._update_servo_state(servo_id, mode=MODES[mode_name])

    def execute_visual_mode(self, servo_id, mode_name):
        self.servo_command_modes[servo_id].set(mode_name)
        self.execute_visual_command(servo_id, mode_name)

    def execute_visual_command(self, servo_id, mode_name=None):
        mode_name = mode_name or self.servo_command_modes[servo_id].get()
        if mode_name == "Servo":
            speed = self._value(self.servo_command_servo_speeds[servo_id], "velocidad del modo Servo")
            acceleration = self._value(self.servo_command_servo_accelerations[servo_id], "aceleracion del modo Servo")
            position = self._value(self.servo_command_positions[servo_id], "posicion del servo {}".format(servo_id))
            if speed is None or acceleration is None or position is None or not 0 <= speed <= MAX_SPEED or not 0 <= acceleration <= MAX_ACCELERATION or not 0 <= position <= 4095:
                messagebox.showerror("Comando invalido", "Posicion 0-4095, velocidad 0-3073 y aceleracion 0-150.")
                return
            self._update_servo_state(servo_id, mode=MODES["Servo"])
            self._set_visual_target(servo_id, position)
            command = "main.cortina.comando(0, position={}, servo_id={})".format(position, servo_id)
            label = "Servo {} a {}".format(servo_id, position)
        elif mode_name == "Rueda":
            wheel_speed = self._value(self.servo_command_speeds[servo_id], "velocidad rueda")
            acceleration = self._value(self.servo_command_wheel_accelerations[servo_id], "aceleracion del modo Rueda")
            if wheel_speed is None or acceleration is None or not -MAX_SPEED <= wheel_speed <= MAX_SPEED or not 0 <= acceleration <= MAX_ACCELERATION:
                messagebox.showerror("Comando invalido", "Velocidad -3073 a 3073 y aceleracion 0-150.")
                return
            speed = abs(wheel_speed)
            self._update_servo_state(servo_id, mode=MODES["Rueda"], torque_enabled=True)
            command = "main.cortina.comando(1, speed={}, servo_id={})".format(wheel_speed, servo_id)
            label = "Rueda {} a {}".format(servo_id, wheel_speed)
        else:
            speed = self._value(self.servo_command_multiturn_speeds[servo_id], "velocidad del modo Multivuelta")
            acceleration = self._value(self.servo_command_multiturn_accelerations[servo_id], "aceleracion del modo Multivuelta")
            turns = self._float_value(self.servo_command_turns[servo_id], "vueltas del servo {}".format(servo_id))
            if speed is None or acceleration is None or turns is None or not 0 <= speed <= MAX_SPEED or not 0 <= acceleration <= MAX_ACCELERATION or not -MULTITURN_LIMIT <= turns <= MULTITURN_LIMIT:
                messagebox.showerror("Comando invalido", "Vueltas -999.99 a 999.99, velocidad 0-3073 y aceleracion 0-150.")
                return
            current = self.visual_targets.get(servo_id, self.visual_positions.get(servo_id, 2000))
            self._update_servo_state(servo_id, mode=MODES["Multivuelta"])
            self._set_visual_target(servo_id, current - turns * COUNTS_PER_TURN, allow_multiturn=True)
            command = "main.cortina.comando(3, turns={}, servo_id={})".format(turns, servo_id)
            label = "Multivuelta {}: {} vueltas".format(servo_id, turns)
        code = "main.cortina.configure_motion({}, {}); {}".format(speed, acceleration, command)
        self.run_remote(code, label)

    def set_visual_torque(self, servo_id, enabled):
        self._update_servo_state(servo_id, torque_enabled=enabled)
        self.run_remote(
            "main.cortina.torque_servo({}, {})".format(servo_id, enabled),
            "Torque {} servo {}".format("ON" if enabled else "OFF", servo_id),
        )

    def stop_visual_servo(self, servo_id):
        self._update_servo_state(servo_id, torque_enabled=False)
        self.visual_targets[servo_id] = self.visual_positions[servo_id]
        self.run_remote(
            "main.cortina.parar_servo({})".format(servo_id),
            "Parando servo {}".format(servo_id),
        )

    def reset_visual_turns(self, servo_id):
        self._update_servo_state(servo_id, turns=0.0)
        self.run_remote(
            "main.cortina.reset_absolute_turns({})".format(servo_id),
            "Poniendo a cero vueltas del servo {}".format(servo_id),
        )

    def stop_all_visuals(self):
        for servo_id in self.servo_visuals:
            self._update_servo_state(servo_id, torque_enabled=False)
            self.visual_targets[servo_id] = self.visual_positions[servo_id]
        self.run_remote("main.cortina.parar()", "Deteniendo")

    def _add_button_hints(self, parent):
        hints = {
            "Abrir": "Mueve ambos servos hacia la posicion de apertura.",
            "Cerrar": "Mueve ambos servos hacia la posicion de cierre.",
            "Parar": "Detiene el movimiento y desactiva el torque del servo.",
            "Mover ambos": "Mueve ambos servos a la posicion indicada.",
            "Mover": "Ejecuta el movimiento angular del modo Servo.",
            "Girar": "Ejecuta el movimiento del modo Rueda o Multivuelta.",
            "Torque ON": "Activa el torque del servo seleccionado.",
            "OFF": "Desactiva el torque del servo seleccionado.",
            "Leer estado": "Lee la posicion, modo, torque y limites reales.",
            "Escanear servos": "Busca servos ST3215 conectados al bus.",
            "Ejecutar comando": "Envía el comando del modo seleccionado.",
            "Torque OFF": "Desactiva el torque del servo seleccionado.",
            "Leer configuracion": "Lee la configuración real del servo.",
            "Aplicar configuracion": "Guarda modo, límites e importe máximo de torque.",
            "Cambiar ID": "Cambia el identificador del servo.",
            "Aplicar movimiento": "Guarda la velocidad y aceleración globales.",
        }
        for widget in parent.winfo_children():
            if isinstance(widget, ttk.Button):
                text = widget.cget("text")
                ToolTip(widget, hints.get(text, "Ejecuta: {}.".format(text.lower())))
            self._add_button_hints(widget)

    def update_command_fields(self, event=None):
        is_multiturn = self.command_mode.get() == "Multivuelta"
        self.command_value_label.configure(text="Vueltas (-999.99 a 999.99):" if is_multiturn else "Posicion (0-4095):")
        self.command_position_input.configure(state="disabled" if is_multiturn else "normal")
        self.command_turns_label.configure(state="normal" if is_multiturn else "disabled")
        self.command_turns_input.configure(state="normal" if is_multiturn else "disabled")

    def execute_command(self):
        mode_name = self.command_mode.get()
        if mode_name == "Servo":
            try:
                position = int(self.command_position.get())
            except (TypeError, ValueError):
                messagebox.showerror("Comando invalido", "La posicion debe ser un entero.")
                return
            if not 0 <= position <= 4095:
                messagebox.showerror("Comando invalido", "La posicion debe estar entre 0 y 4095.")
                return
            try:
                servo_id = int(self.command_servo_id.get())
            except (TypeError, ValueError):
                messagebox.showerror("Comando invalido", "El ID debe ser un entero.")
                return
            speed = self._value(self.speed, "velocidad")
            acceleration = self._value(self.acceleration, "aceleracion")
            if speed is None or acceleration is None:
                return
            code = "main.cortina.configure_motion({}, {}); main.cortina.comando(0, position={}, servo_id={})".format(speed, acceleration, position, servo_id)
            self._update_servo_state(servo_id, mode=MODES["Servo"])
            self._set_visual_target(servo_id, position)
            self.run_remote(code, "Ejecutando posicion")
        elif mode_name == "Multivuelta":
            try:
                turns = float(self.command_turns.get())
            except (TypeError, ValueError):
                messagebox.showerror("Comando invalido", "Las vueltas deben ser un numero entre -999.99 y 999.99.")
                return
            if not -MULTITURN_LIMIT <= turns <= MULTITURN_LIMIT:
                messagebox.showerror("Comando invalido", "Las vueltas deben estar entre -999.99 y 999.99.")
                return
            try:
                servo_id = int(self.command_servo_id.get())
            except (TypeError, ValueError):
                messagebox.showerror("Comando invalido", "El ID debe ser un entero.")
                return
            speed = self._value(self.speed, "velocidad")
            acceleration = self._value(self.acceleration, "aceleracion")
            if speed is None or acceleration is None:
                return
            code = "main.cortina.configure_motion({}, {}); main.cortina.comando(3, turns={}, servo_id={})".format(speed, acceleration, turns, servo_id)
            current = self.visual_targets.get(servo_id, self.visual_positions.get(servo_id, 2000))
            self._update_servo_state(servo_id, mode=MODES["Multivuelta"])
            self._set_visual_target(servo_id, current - turns * COUNTS_PER_TURN, allow_multiturn=True)
            self.run_remote(code, "Ejecutando multivuelta")
        else:
            messagebox.showinfo("Modo rueda", "Este panel reserva el modo rueda para una orden de velocidad.")

    def run_servo_command(self, template, label):
        try:
            servo_id = int(self.command_servo_id.get())
        except (TypeError, ValueError):
            messagebox.showerror("Comando invalido", "Selecciona un ID de servo.")
            return
        if "True" in template:
            self._update_servo_state(servo_id, torque_enabled=True)
        elif "False" in template:
            self._update_servo_state(servo_id, torque_enabled=False)
        self.run_remote("main.cortina." + template.format(servo_id), label + " servo {}".format(servo_id))

    def read_status(self):
        command = "print('ids', main.cortina.servo_ids); print('positions', main.cortina.show_status('estado')); print('config1', main.cortina.configuration(1)); print('config2', main.cortina.configuration(2))"
        self.run_remote(command, "Leyendo estado")

    def _set_visual_target(self, servo_id, position, allow_multiturn=False):
        state = self.servo_state[servo_id]
        if state["mode"] == MODES["Servo"] and not allow_multiturn:
            position = max(state["min_angle"], min(state["max_angle"], float(position)))
        if state["mode"] == MODES["Multivuelta"] or allow_multiturn:
            self.visual_targets[servo_id] = float(position)
        else:
            self.visual_targets[servo_id] = max(0, min(4095, float(position)))

    def _draw_servo(self, servo_id):
        canvas = self.servo_visuals[servo_id]
        canvas.delete("all")
        width = max(canvas.winfo_width(), 260)
        height = 115
        center_x = width / 2
        center_y = 78
        radius = 48
        state = self.servo_state[servo_id]
        position = self.visual_positions[servo_id]
        minimum = state["min_angle"]
        maximum = state["max_angle"]
        is_servo_mode = state["mode"] == MODES["Servo"]
        if is_servo_mode:
            normalized = (position - minimum) / max(1, maximum - minimum)
            angle = 135 - max(0, min(1, normalized)) * 270
        else:
            angle = 270 - (position % COUNTS_PER_TURN) / COUNTS_PER_TURN * 360
        radians = math.radians(angle)
        end_x = center_x + radius * math.cos(radians)
        end_y = center_y - radius * math.sin(radians)
        if is_servo_mode:
            canvas.create_arc(center_x - radius, center_y - radius, center_x + radius, center_y + radius,
                              start=0, extent=180, style="arc", outline="#5f7185", width=2)
        else:
            canvas.create_oval(center_x - radius, center_y - radius, center_x + radius, center_y + radius,
                               outline="#5f7185", width=2)
        canvas.create_line(center_x, center_y, end_x, end_y, fill="#54d6c7", width=5)
        canvas.create_oval(center_x - 9, center_y - 9, center_x + 9, center_y + 9, fill="#f3c969", outline="")
        canvas.create_oval(end_x - 5, end_y - 5, end_x + 5, end_y + 5, fill="#f3c969", outline="")
        canvas.create_text(8, 10, anchor="w", text="ID {}".format(servo_id), fill="#d7e1ea", font=("Segoe UI", 9, "bold"))
        value_text = "pos {:4.0f}".format(position) if state["mode"] != MODES["Multivuelta"] else "abs {:.2f}v faltan {:.2f}v".format(state["turns"], state["remaining_turns"])
        canvas.create_text(width - 8, 10, anchor="e", text=value_text, fill="#d7e1ea", font=("Segoe UI", 9))
        mode_name = next(name for name, value in MODES.items() if value == state["mode"])
        torque = "ON" if state["torque_enabled"] else "OFF" if state["torque_enabled"] is False else "?"
        canvas.create_text(8, 27, anchor="w", text="{} | torque {}".format(mode_name, torque),
                  fill="#91a4b5", font=("Segoe UI", 8))
        canvas.create_text(width - 8, 27, anchor="e", text="lim {}-{}".format(minimum, maximum),
                  fill="#91a4b5", font=("Segoe UI", 8))

    def _animate_visuals(self):
        for servo_id in self.servo_visuals:
            state = self.servo_state[servo_id]
            current = self.visual_positions[servo_id]
            target = self.visual_targets[servo_id]
            if state["mode"] == MODES["Rueda"] and state["torque_enabled"]:
                self.visual_positions[servo_id] = (current - max(1, self.motion_speed) * 0.02) % COUNTS_PER_TURN
                self._draw_servo(servo_id)
                continue
            delta = target - current
            if abs(delta) > 1:
                step = 0.12 + min(0.18, self.motion_speed / 10000)
                self.visual_positions[servo_id] = current + delta * step
            else:
                self.visual_positions[servo_id] = target
            self._draw_servo(servo_id)
        self.after(40, self._animate_visuals)

    def scan_servos(self):
        self.run_remote("print('scan', main.cortina.scan_servos(1, 20))", "Escaneando servos")

    def read_configuration(self):
        servo_id = self._value(self.servo_id, "servo")
        if servo_id is not None:
            self.run_remote("print(main.cortina.configuration({}))".format(servo_id), "Leyendo configuracion")

    def apply_configuration(self):
        values = [self._value(variable, name) for variable, name in (
            (self.servo_id, "servo"), (self.min_angle, "limite minimo"),
            (self.max_angle, "limite maximo"),
            (self.torque_limit, "torque"),
        )]
        if any(value is None for value in values):
            return
        servo_id, minimum, maximum, torque_limit = values
        if minimum >= maximum or not 0 <= torque_limit <= 1000:
            messagebox.showerror("Configuracion invalida", "Revisa limites y torque.")
            return
        mode = MODES[self.mode.get()]
        self._update_servo_state(
            servo_id,
            mode=mode,
            min_angle=minimum,
            max_angle=maximum,
            torque_limit=torque_limit,
            torque_enabled=False,
        )
        code = "main.cortina.configure_servo({}, {}, {}, {}, {})".format(servo_id, minimum, maximum, mode, torque_limit)
        self.run_remote(code, "Aplicando configuracion")

    def change_id(self):
        current_id = self._value(self.servo_id, "servo")
        new_id = self._value(self.new_id, "ID nuevo")
        if current_id is None or new_id is None:
            return
        if not 1 <= new_id <= 20 or current_id == new_id:
            messagebox.showerror("ID invalido", "El ID nuevo debe estar entre 1 y 20 y ser diferente.")
            return
        if not messagebox.askyesno("Confirmar cambio de ID", "Cambiar el servo {} al ID {}?".format(current_id, new_id)):
            return
        code = "main.cortina.change_id({}, {})".format(current_id, new_id)
        self.run_remote(code, "Cambiando ID")

    def apply_motion(self):
        speed = self._value(self.speed, "velocidad")
        acceleration = self._value(self.acceleration, "aceleracion")
        if speed is None or acceleration is None or not 0 <= speed <= MAX_SPEED or not 0 <= acceleration <= MAX_ACCELERATION:
            messagebox.showerror("Movimiento invalido", "Revisa velocidad y aceleracion.")
            return
        self.motion_speed = speed
        self.motion_acceleration = acceleration
        self.run_remote("main.cortina.configure_motion({}, {})".format(speed, acceleration), "Aplicando movimiento")

    def save_blind_configuration(self):
        servo_id = self._value(self.blind_servo_id, "servo de persiana")
        rolled = self._float_value(self.blind_rolled_turns, "vueltas enrollada")
        unrolled = self._float_value(self.blind_unrolled_turns, "vueltas desenrollada")
        if servo_id is None or rolled is None or unrolled is None:
            return
        if rolled == unrolled:
            messagebox.showerror("Persiana invalida", "Los extremos enrollado y desenrollado deben ser distintos.")
            return
        self.run_remote(
            "main.cortina.configure_blind({}, {}, {})".format(servo_id, rolled, unrolled),
            "Guardando extremos de persiana",
        )

    def move_blind(self):
        servo_id = self._value(self.blind_servo_id, "servo de persiana")
        percent = self._float_value(self.blind_percent, "posicion de persiana")
        if servo_id is None or percent is None or not 0 <= percent <= 100:
            messagebox.showerror("Persiana invalida", "La posicion debe estar entre 0 y 100 por ciento.")
            return
        self.run_remote(
            "main.cortina.move_blind({}, {}, 800, 50)".format(servo_id, percent),
            "Moviendo persiana a {:.0f}%".format(percent),
        )

    def _begin_blind_edit(self, _event=None):
        self.blind_editing = True

    def _end_blind_edit(self, _event=None):
        self.blind_editing = True

    def _preview_blind(self, value):
        self.blind_position_label.configure(text="{:.0f}% desenrollada".format(float(value)))
        self._draw_blind(float(value))

    def _draw_blind(self, percent):
        canvas = self.blind_canvas
        canvas.delete("all")
        width = max(canvas.winfo_width(), 420)
        height = max(canvas.winfo_height(), 260)
        left, top, right, bottom = 48, 24, width - 48, height - 20
        canvas.create_rectangle(left, top, right, bottom, fill="#7eb6c9", outline="#53636c", width=8)
        tube_y = top + 12
        canvas.create_rectangle(left - 10, tube_y - 9, right + 10, tube_y + 9, fill="#46545b", outline="#263238", width=2)
        canvas.create_oval(left - 18, tube_y - 12, left + 2, tube_y + 12, fill="#2d383e", outline="#17212b")
        canvas.create_oval(right - 2, tube_y - 12, right + 18, tube_y + 12, fill="#2d383e", outline="#17212b")
        blind_height = (bottom - tube_y) * max(0.0, min(100.0, percent)) / 100
        if blind_height:
            canvas.create_rectangle(left + 4, tube_y + 9, right - 4, tube_y + blind_height, fill="#e8eef0", outline="")
            y = tube_y + 15
            while y < tube_y + blind_height:
                canvas.create_line(left + 4, y, right - 4, y, fill="#aab8bd", width=2)
                y += 15
        canvas.create_text(width / 2, height - 10, text="{:.1f}% desenrollada".format(percent), fill="#17212b", font=("Segoe UI", 10, "bold"))

    def _value(self, variable, name):
        try:
            return int(variable.get())
        except (TypeError, ValueError):
            messagebox.showerror("Valor invalido", "Revisa: {}.".format(name))
            return None

    def _float_value(self, variable, name):
        try:
            return float(variable.get())
        except (TypeError, ValueError):
            messagebox.showerror("Valor invalido", "Revisa: {}.".format(name))
            return None

    def run_remote(self, code, label):
        if self.busy:
            self.write_log("Espera a que termine la operacion actual.")
            return
        self.busy = True
        self.status.set(label + "...")
        self._set_buttons(False)
        threading.Thread(target=self._remote_worker, args=(code,), daemon=True).start()

    def _remote_worker(self, code):
        try:
            output = self._execute_persistent(code)
            self.results.put((0, output or "Operacion terminada"))
        except Exception as error:
            self._close_serial()
            self.results.put((-1, "Error de comunicacion: {}".format(error)))

    def _execute_persistent(self, code):
        if self.use_web.get():
            url = self.web_url.get().strip().rstrip("/") + "/api/pc"
            request_data = urllib.parse.urlencode({"code": code}).encode("utf-8")
            request = urllib.request.Request(
                url,
                data=request_data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = response.read().decode("utf-8")
            match = re.search(r'"message":"((?:\\.|[^"\\])*)"', payload)
            if not match:
                raise RuntimeError("respuesta web invalida: {}".format(payload[:160]))
            return bytes(match.group(1), "utf-8").decode("unicode_escape")
        with self.serial_lock:
            if self.serial_conn is None or not self.serial_conn.is_open:
                self.serial_conn = serial.Serial(self.port.get(), 115200, timeout=0.1)
                time.sleep(0.3)
                self.serial_conn.write(b"\x03\x03\x01")
                time.sleep(0.1)
                self.serial_conn.reset_input_buffer()
                self.serial_conn.write(b"import main; print('GUI conectado')\x04")
                self._read_raw_result()
            self.serial_conn.write(code.encode("utf-8") + b"\x04")
            return self._read_raw_result()

    def _read_raw_result(self):
        output = bytearray()
        deadline = time.time() + 15
        while time.time() < deadline:
            chunk = self.serial_conn.read(256)
            if chunk:
                output.extend(chunk)
                if b"\x04\x04" in output:
                    break
        marker = output.find(b"\x04\x04")
        if marker < 0:
            raise TimeoutError("sin respuesta del ESP32")
        return bytes(output[:marker]).decode("utf-8", errors="replace").strip("\r\n>")

    def _close_serial(self):
        with self.serial_lock:
            if self.serial_conn is not None:
                self.serial_conn.close()
                self.serial_conn = None

    def close(self):
        self._close_serial()
        self.destroy()

    def _poll_results(self):
        try:
            returncode, output = self.results.get_nowait()
        except queue.Empty:
            self.after(100, self._poll_results)
            return
        self.busy = False
        self._set_buttons(True)
        self.status.set("Operacion terminada" if returncode == 0 else "Operacion con error")
        self.write_log(output)
        self._sync_visual_positions(output)
        self._sync_configuration(output)
        self.after(100, self._poll_results)

    def _poll_absolute_turns(self):
        if not self.absolute_polling:
            self.absolute_polling = True
            threading.Thread(target=self._absolute_turns_worker, daemon=True).start()
        self.after(500, self._poll_absolute_turns)

    def _absolute_turns_worker(self):
        try:
            if self.use_web.get():
                url = self.web_url.get().strip().rstrip("/") + "/api/status"
                with urllib.request.urlopen(url, timeout=2) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                states = payload["status"]
            else:
                output = self._execute_persistent(
                    "print({'absolute_turns': main.cortina.multiturn_status(1)['absolute_turns'], 'remaining_turns': main.cortina.multiturn_status(1)['remaining_turns'], 'percent': main.cortina.multiturn_status(1)['blind_percent']}); print({'absolute_turns': main.cortina.multiturn_status(2)['absolute_turns'], 'remaining_turns': main.cortina.multiturn_status(2)['remaining_turns'], 'percent': main.cortina.multiturn_status(2)['blind_percent']})"
                )
                values = [ast.literal_eval(match.group(0)) for match in re.finditer(r"\{[^{}]+\}", output)]
                states = {
                    str(servo_id): {
                        "absolute_turns": values[servo_id - 1]["absolute_turns"],
                        "remaining_turns": values[servo_id - 1]["remaining_turns"],
                        "blind_percent": values[servo_id - 1]["percent"],
                    }
                    for servo_id in (1, 2) if len(values) >= servo_id
                }
            self.absolute_results.put(states)
        except Exception:
            pass
        finally:
            self.absolute_polling = False

    def _poll_absolute_results(self):
        try:
            states = self.absolute_results.get_nowait()
        except queue.Empty:
            self.after(150, self._poll_absolute_results)
            return
        for servo_id in (1, 2):
            state = states.get(str(servo_id), {})
            if "absolute_turns" in state:
                self._update_servo_state(
                    servo_id,
                    turns=float(state["absolute_turns"]),
                    remaining_turns=float(state.get("remaining_turns", 0.0)),
                    torque_enabled=self.servo_state[servo_id]["torque_enabled"],
                )
            if "blind_percent" in state and servo_id == self.blind_servo_id.get():
                self.blind_actual_percent = float(state["blind_percent"])
                if not self.blind_editing:
                    self.blind_percent.set(self.blind_actual_percent)
                    self.blind_position_label.configure(text="{:.0f}% desenrollada".format(self.blind_actual_percent))
                self._draw_blind(self.blind_actual_percent)
        self.after(150, self._poll_absolute_results)

    def _sync_visual_positions(self, output):
        match = re.search(r"positions\s*\(?\[?\s*(-?\d+)\s*,\s*(-?\d+)", output, re.IGNORECASE)
        if not match:
            return
        for servo_id, value in zip((1, 2), match.groups()):
            position = float(value)
            self.visual_positions[servo_id] = position
            self.visual_targets[servo_id] = position

    def _update_servo_state(self, servo_id, **values):
        if servo_id not in self.servo_state:
            return
        self.servo_state[servo_id].update(values)
        self._set_visual_target(servo_id, self.visual_targets[servo_id])

    def _sync_configuration(self, output):
        for match in re.finditer(r"\{[^{}]+\}", output, re.DOTALL):
            try:
                configuration = ast.literal_eval(match.group(0))
            except (SyntaxError, ValueError):
                continue
            servo_id = configuration.get("id")
            if servo_id not in self.servo_state:
                continue
            self._update_servo_state(
                servo_id,
                mode=int(configuration.get("mode", 0)),
                torque_enabled=bool(configuration.get("torque_enabled", 0)),
                min_angle=int(configuration.get("min_angle", MIN_POSITION)),
                max_angle=int(configuration.get("max_angle", MAX_POSITION)),
                torque_limit=int(configuration.get("torque_limit", 1000)),
            )
            position = self.visual_positions[servo_id]
            position_text = "{:.0f}".format(position) if position == int(position) else "{:.1f}".format(position)
            self.servo_status_labels[servo_id].configure(
                text="Estado real: modo {} | pos {} | torque {} | lim {}-{}".format(
                    configuration.get("mode"),
                    position_text,
                    "ON" if configuration.get("torque_enabled") else "OFF",
                    configuration.get("min_angle"),
                    configuration.get("max_angle"),
                )
            )

    def _set_buttons(self, enabled):
        state = "normal" if enabled else "disabled"
        self.status_button.configure(state=state)
        self.scan_button.configure(state=state)
        for child in self.winfo_children():
            self._set_child_buttons(child, state)

    def _set_child_buttons(self, parent, state):
        for child in parent.winfo_children():
            if isinstance(child, (ttk.Button, ttk.Spinbox)):
                child.configure(state=state)
            self._set_child_buttons(child, state)


if __name__ == "__main__":
    TestPanel().mainloop()