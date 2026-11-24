-- =============================================================================
-- PulseGrid - Esquema de Base de Datos MySQL / MariaDB
-- Compatible con MySQL 8.0+ y MariaDB 10.6+ (Hostinger)
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- 1. Dispositivos sincronizados desde Tuya Cloud
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id VARCHAR(64) NOT NULL COMMENT 'ID único del dispositivo en Tuya Cloud',
  name VARCHAR(150) NOT NULL COMMENT 'Nombre original en Tuya',
  custom_name VARCHAR(150) NULL COMMENT 'Nombre personalizado en PulseGrid',
  category VARCHAR(32) NOT NULL DEFAULT 'unknown' COMMENT 'Categoría Tuya (ej. cz, wk, dj, wsdcg)',
  product_id VARCHAR(64) NULL,
  product_name VARCHAR(150) NULL,
  icon_url VARCHAR(512) NULL,
  room VARCHAR(100) NULL COMMENT 'Habitación o zona para agrupar en el dashboard',
  is_online TINYINT(1) NOT NULL DEFAULT 0,
  last_online_at DATETIME NULL,
  last_offline_alert_at DATETIME NULL COMMENT 'Control de cooldown para alertas de desconexión',
  dp_schema JSON NULL COMMENT 'Especificaciones de Data Points (tipo, min, max, scale, unit, values)',
  last_status JSON NULL COMMENT 'Último snapshot de valores DP cacheados',
  notify_on_offline TINYINT(1) NOT NULL DEFAULT 0,
  offline_cooldown_minutes INT UNSIGNED NOT NULL DEFAULT 60,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_devices_online (is_online),
  INDEX idx_devices_category (category),
  INDEX idx_devices_room (room),
  INDEX idx_devices_offline_notify (notify_on_offline, is_online)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 2. Telemetría e historial de cambios de estado (Chart.js)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id VARCHAR(64) NOT NULL,
  dp_code VARCHAR(64) NOT NULL COMMENT 'Código del Data Point (ej. temp_current, switch_1)',
  value_type ENUM('boolean', 'number', 'string', 'json') NOT NULL,
  value_numeric DOUBLE NULL COMMENT 'Valor numérico o 0/1 para booleanos (optimiza gráficas)',
  value_text VARCHAR(255) NULL COMMENT 'Valor textual para enums o strings',
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_telemetry_device
    FOREIGN KEY (device_id) REFERENCES devices (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  -- Índice compuesto principal para series temporales por dispositivo y parámetro
  INDEX idx_telemetry_device_dp_time (device_id, dp_code, recorded_at),
  -- Índice para consultas globales por rango y limpieza periódica por retención
  INDEX idx_telemetry_recorded_at (recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 3. Reglas de automatización (SI / CUANDO / ENTONCES)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  description TEXT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  condition_logic ENUM('ALL', 'ANY') NOT NULL DEFAULT 'ALL' COMMENT 'ALL = todas (AND), ANY = cualquiera (OR)',
  conditions_json JSON NOT NULL COMMENT 'Bloque SI: condiciones dispositivo vs valor, dispositivo vs dispositivo o clima',
  schedule_json JSON NOT NULL COMMENT 'Bloque CUANDO: horarios, días, sunrise/sunset con offsets y clima exterior',
  actions_json JSON NOT NULL COMMENT 'Bloque ENTONCES: lista de comandos a dispositivos y/o alerta por email',
  cooldown_minutes INT UNSIGNED NOT NULL DEFAULT 5 COMMENT 'Minutos mínimos entre disparos consecutivos',
  last_triggered_at DATETIME NULL,
  last_evaluated_at DATETIME NULL,
  last_eval_snapshot JSON NULL COMMENT 'Resultado en vivo de cada condición para depuración en UI',
  trigger_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_automations_enabled (is_enabled),
  INDEX idx_automations_last_triggered (last_triggered_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 4. Historial de ejecuciones y trazabilidad de automatizaciones
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  automation_id INT UNSIGNED NOT NULL,
  status ENUM('triggered', 'partial_error', 'error', 'skipped_cooldown') NOT NULL,
  evaluation_details JSON NULL COMMENT 'Valores evaluados y estado cumplido/no cumplido por condición',
  actions_result JSON NULL COMMENT 'Resultado por cada acción ejecutada (dispositivos y correo)',
  error_message TEXT NULL,
  executed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_autologs_automation
    FOREIGN KEY (automation_id) REFERENCES automations (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  INDEX idx_autologs_automation_time (automation_id, executed_at),
  INDEX idx_autologs_executed_at (executed_at),
  INDEX idx_autologs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 5. Destinatarios de alertas por correo
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_recipients (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NULL,
  email VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  receive_automation_alerts TINYINT(1) NOT NULL DEFAULT 1,
  receive_offline_alerts TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alert_recipients_email (email),
  INDEX idx_alert_recipients_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 6. Registro de alertas enviadas y auditoría de cooldown
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  alert_type ENUM('automation', 'device_offline', 'device_online', 'system', 'test') NOT NULL,
  source_id VARCHAR(64) NULL COMMENT 'ID de la regla (automation_id) o dispositivo (device_id)',
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  recipients JSON NOT NULL COMMENT 'Lista de correos destinatarios',
  delivery_status ENUM('sent', 'failed', 'suppressed_cooldown') NOT NULL,
  error_message TEXT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_alertlogs_type_source_time (alert_type, source_id, sent_at),
  INDEX idx_alertlogs_sent_at (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 7. Configuración global de la aplicación (ubicación, SMTP opcional, retención)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(64) NOT NULL,
  setting_value JSON NOT NULL,
  description VARCHAR(255) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Valores iniciales por defecto
INSERT INTO app_settings (setting_key, setting_value, description)
VALUES
  (
    'location',
    JSON_OBJECT('latitude', 19.4326, 'longitude', -99.1332, 'timezone', 'America/Mexico_City', 'label', 'Ciudad de México'),
    'Coordenadas y zona horaria para Open-Meteo (clima, amanecer y atardecer)'
  ),
  (
    'retention',
    JSON_OBJECT('telemetry_days', 90, 'automation_logs_days', 30, 'alert_logs_days', 60),
    'Política de retención de datos históricos en días'
  )
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- -----------------------------------------------------------------------------
-- 8. Cuentas (espacios de dispositivos) y Usuarios
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  owner_user_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_accounts_owner (owner_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  INDEX idx_users_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_members (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  role ENUM('owner', 'admin', 'member', 'viewer') NOT NULL DEFAULT 'member',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_account_member (account_id, user_id),
  CONSTRAINT fk_members_account
    FOREIGN KEY (account_id) REFERENCES accounts (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_members_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE,
  INDEX idx_members_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  account_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  user_agent VARCHAR(255) NULL,
  ip_address VARCHAR(64) NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  CONSTRAINT fk_sessions_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_sessions_account
    FOREIGN KEY (account_id) REFERENCES accounts (id)
    ON DELETE CASCADE,
  INDEX idx_sessions_user (user_id),
  INDEX idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reset_token (token_hash),
  CONSTRAINT fk_reset_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE,
  INDEX idx_reset_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id INT UNSIGNED NOT NULL,
  invited_by_user_id INT UNSIGNED NOT NULL,
  email VARCHAR(255) NOT NULL,
  role ENUM('admin', 'member', 'viewer') NOT NULL DEFAULT 'member',
  token_hash CHAR(64) NOT NULL,
  status ENUM('pending', 'accepted', 'revoked', 'expired') NOT NULL DEFAULT 'pending',
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invitations_token (token_hash),
  CONSTRAINT fk_invitations_account
    FOREIGN KEY (account_id) REFERENCES accounts (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_invitations_inviter
    FOREIGN KEY (invited_by_user_id) REFERENCES users (id)
    ON DELETE CASCADE,
  INDEX idx_invitations_account_status (account_id, status),
  INDEX idx_invitations_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
