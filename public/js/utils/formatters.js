/**
 * Utilidades globales de formato para PulseGrid:
 * - Fechas: YYYY-MM-DD (zona horaria local del visitante)
 * - Horas: 24h (HH:mm / HH:mm:ss)
 * - Cifras: separador de miles con coma (1,234.56)
 * - Traducción de DPs y unidades de Tuya (elimina texto en chino)
 */

export const VISITOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const CJK_REGEX = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

const UNIT_MAP = {
  '秒': 's',
  '分钟': 'min',
  '小时': 'h',
  '℃': '°C',
  '℉': '°F',
  '度': '°',
  '次': 'veces',
  '%RH': '%',
};

const DP_LABELS = {
  switch: 'Interruptor',
  switch_1: 'Interruptor 1',
  switch_2: 'Interruptor 2',
  switch_3: 'Interruptor 3',
  switch_led: 'Luz',
  switch_led_1: 'Luz 1',
  switch_usb1: 'USB 1',
  switch_all: 'Interruptor general',
  power_go: 'Encendido',
  bright_value: 'Brillo',
  bright_value_1: 'Brillo 1',
  bright_value_v2: 'Brillo',
  brightness_min_1: 'Brillo mínimo',
  brightness_max_1: 'Brillo máximo',
  temp_value: 'Temperatura de color',
  temp_value_v2: 'Temperatura de color',
  work_mode: 'Modo de trabajo',
  led_type_1: 'Tipo de LED',
  mode: 'Modo',
  countdown_1: 'Temporizador 1',
  countdown_2: 'Temporizador 2',
  countdown_usb1: 'Temporizador USB 1',
  countdown_set: 'Temporizador',
  relay_status: 'Estado tras corte',
  light_mode: 'Indicador LED',
  child_lock: 'Bloqueo infantil',
  cycle_time: 'Ciclo programado',
  random_time: 'Modo aleatorio',
  switch_inching: 'Pulso (Inching)',
  temp_current: 'Temperatura actual',
  temp_current_f: 'Temperatura actual (°F)',
  temp_set: 'Temperatura objetivo',
  temp_set_f: 'Temperatura objetivo (°F)',
  temp_unit_convert: 'Unidad de temperatura',
  va_temperature: 'Temperatura',
  va_humidity: 'Humedad',
  humidity: 'Humedad',
  humidity_value: 'Humedad',
  window_check: 'Detección ventana abierta',
  work_days: 'Días laborales',
  work_state: 'Estado de trabajo',
  factory_reset: 'Restablecer fábrica',
  backlight: 'Retroiluminación',
  backlight_enum: 'Modo retroiluminación',
  fault: 'Falla',
  holiday_temp_set: 'Temp. vacaciones',
  holiday_temp_set_f: 'Temp. vacaciones (°F)',
  fan_speed_percent: 'Velocidad ventilador',
  switch_horizontal: 'Oscilación horizontal',
  fan_beep: 'Sonido',
  light: 'Luz',
  battery_percentage: 'Batería',
  cur_power: 'Potencia actual',
  cur_power_a: 'Potencia Canal A',
  cur_power_b: 'Potencia Canal B',
  power_a: 'Potencia Canal A',
  power_b: 'Potencia Canal B',
  total_power: 'Potencia total',
  cur_voltage: 'Voltaje',
  voltage_a: 'Voltaje A',
  voltage_b: 'Voltaje B',
  cur_current: 'Corriente',
  cur_current_a: 'Corriente Canal A',
  cur_current_b: 'Corriente Canal B',
  current_a: 'Corriente Canal A',
  current_b: 'Corriente Canal B',
  add_ele: 'Energía acumulada',
  total_forward_energy: 'Energía directa total',
  forward_energy_total: 'Energía directa total',
  reverse_energy_total: 'Energía inversa total',
  energy_forword_a: 'Energía directa A',
  energy_forword_b: 'Energía directa B',
  energy_reverse_a: 'Energía inversa A',
  energy_reserse_b: 'Energía inversa B',
  power_factor: 'Factor de potencia A',
  power_factor_a: 'Factor de potencia A',
  power_factor_b: 'Factor de potencia B',
  freq: 'Frecuencia',
  direction_a: 'Dirección flujo A',
  direction_b: 'Dirección flujo B',
  buz_enable: 'Alarma sonora',
  ov_enable: 'Protección sobrevoltaje',
  ov_status: 'Estado sobrevoltaje',
  ov_threshold: 'Umbral sobrevoltaje',
  uv_enable: 'Protección bajo voltaje',
  uv_status: 'Estado bajo voltaje',
  uv_threshold: 'Umbral bajo voltaje',
  oc_enable: 'Protección sobrecorriente A',
  oc_enable_b: 'Protección sobrecorriente B',
  oc_status: 'Estado sobrecorriente A',
  oc_status_b: 'Estado sobrecorriente B',
  oc_threshold: 'Umbral sobrecorriente A',
  oc_threshold_b: 'Umbral sobrecorriente B',
  op_enable: 'Protección sobrepotencia A',
  op_enable_b: 'Protección sobrepotencia B',
  op_status: 'Estado sobrepotencia A',
  op_status_b: 'Estado sobrepotencia B',
  op_threshold: 'Umbral sobrepotencia A',
  op_threshold_b: 'Umbral sobrepotencia B',
  report_rate_control: 'Intervalo de reporte',
  automatic_lock: 'Bloqueo automático',
  auto_lock_time: 'Tiempo de bloqueo auto',
  normal_open_switch: 'Modo paso libre',
  normal_open_period: 'Horario paso libre',
  doorcontact_state: 'Estado puerta',
};

export function hasChinese(str) {
  return CJK_REGEX.test(String(str || ''));
}

export function translateUnit(rawUnit) {
  if (!rawUnit) return '';
  const u = String(rawUnit).trim();
  if (UNIT_MAP[u]) return UNIT_MAP[u];
  if (hasChinese(u)) return '';
  return u;
}

export function translateDpLabel(dpCode, rawName) {
  if (DP_LABELS[dpCode]) return DP_LABELS[dpCode];
  if (rawName && !hasChinese(rawName) && rawName !== dpCode) return String(rawName);
  return String(dpCode || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getDateParts(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VISITOR_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const hourNum = Number(map.hour) % 24;
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: String(hourNum).padStart(2, '0'),
    minute: map.minute,
    second: map.second,
  };
}

/**
 * Formato obligatorio: YYYY-MM-DD (zona horaria local del visitante)
 */
export function formatDate(input) {
  const p = getDateParts(input);
  if (!p) return '—';
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Formato obligatorio: 24h (HH:mm o HH:mm:ss)
 */
export function formatTime(input, withSeconds = true) {
  const p = getDateParts(input);
  if (!p) return '—';
  return withSeconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
}

/**
 * Formato obligatorio: YYYY-MM-DD HH:mm:ss (24h, zona horaria local del visitante)
 */
export function formatDateTime(input, withSeconds = true) {
  const p = getDateParts(input);
  if (!p) return '—';
  const t = withSeconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
  return `${p.year}-${p.month}-${p.day} ${t}`;
}

/**
 * Formato obligatorio de cifras: separador de miles con coma (ej. 1,234.5)
 */
export function formatNumber(value, decimals = null) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);

  const opts =
    decimals !== null && decimals !== undefined
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : { maximumFractionDigits: 2 };

  return new Intl.NumberFormat('en-US', opts).format(num);
}

export default {
  VISITOR_TZ,
  hasChinese,
  translateUnit,
  translateDpLabel,
  formatDate,
  formatTime,
  formatDateTime,
  formatNumber,
};
