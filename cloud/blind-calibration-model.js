(function (root) {
  'use strict';

  function estimateTurns(heightCm, tubeDiameterCm, fabricThicknessMm, motorTurnsPerTubeTurn = 1) {
    const height = Number(heightCm);
    const diameter = Number(tubeDiameterCm);
    const thickness = Number(fabricThicknessMm) / 10;
    const ratio = Number(motorTurnsPerTubeTurn);
    if (!Number.isFinite(height) || height < 20 || height > 1000) throw new Error('La altura debe estar entre 20 y 1000 cm.');
    if (!Number.isFinite(diameter) || diameter < 1 || diameter > 30) throw new Error('El diámetro del tubo debe estar entre 1 y 30 cm.');
    if (!Number.isFinite(thickness) || thickness < 0.001 || thickness > 0.5) throw new Error('El grosor del paño debe estar entre 0.01 y 5 mm.');
    if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 20) throw new Error('La relación motor/tubo debe estar entre 0.1 y 20 vueltas de motor por vuelta de tubo.');

    // L = π n (D + n t): each wrap adds one fabric thickness to the roll radius.
    const tubeTurns = (-diameter + Math.sqrt(diameter * diameter + (4 * thickness * height) / Math.PI)) / (2 * thickness);
    const turns = tubeTurns * ratio;
    if (!Number.isFinite(turns) || turns < 1) throw new Error('Las medidas producen menos de una vuelta; verifica los datos.');
    return turns;
  }

  const model = { estimateTurns };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  root.BlindCalibrationModel = model;
})(typeof globalThis !== 'undefined' ? globalThis : this);
