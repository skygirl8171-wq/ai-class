const fields = [
  '판정',
  '불량유형',
  '관찰·수치 근거',
  '적용 기준과 출처',
  '권고 조치',
  '사람 승인 필요 여부',
];

function normalizeGeminiResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!['OK', 'NG', 'HOLD'].includes(value['판정'])) return null;

  const normalized = {};
  for (const field of fields) {
    if (typeof value[field] !== 'string') return null;
    normalized[field] = value[field];
  }
  return normalized;
}

if (typeof module !== 'undefined') module.exports = { normalizeGeminiResult };