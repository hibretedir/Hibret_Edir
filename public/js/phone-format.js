(function (global) {
  /** Digits only, last 10 (US). */
  function phoneDigits(value) {
    return String(value || '').replace(/\D/g, '').slice(-10);
  }

  /** Format as area-three-four: 310-309-7166 */
  function formatPhoneUS(value) {
    const d = String(value || '').replace(/\D/g, '');
    if (!d) return '';
    const ten = d.length > 10 ? d.slice(-10) : d;
    if (ten.length >= 7) return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6, 10)}`;
    if (ten.length >= 4) return `${ten.slice(0, 3)}-${ten.slice(3)}`;
    return ten;
  }

  /** Input handler — formats as the user types. */
  function fmtPhone(inp) {
    if (!inp) return;
    const start = inp.selectionStart;
    const before = inp.value;
    const formatted = formatPhoneUS(before);
    if (formatted === before) return;
    inp.value = formatted;
    if (typeof start === 'number' && inp === document.activeElement) {
      const diff = formatted.length - before.length;
      const pos = Math.max(0, Math.min(formatted.length, start + diff));
      try { inp.setSelectionRange(pos, pos); } catch (_) { /* ignore */ }
    }
  }

  function bindPhoneInputs(root) {
    const scope = root || document;
    scope.querySelectorAll('input[type="tel"]:not([data-no-phone-format]):not(.pin-input)').forEach((el) => {
      if (el.dataset.phoneBound === '1') return;
      el.dataset.phoneBound = '1';
      el.setAttribute('inputmode', el.getAttribute('inputmode') || 'tel');
      if (!el.getAttribute('maxlength')) el.setAttribute('maxlength', '12');
      if (!el.getAttribute('placeholder')) el.setAttribute('placeholder', 'xxx-xxx-xxxx');
      el.addEventListener('input', () => fmtPhone(el));
      if (el.value) el.value = formatPhoneUS(el.value);
    });
  }

  global.phoneDigits = phoneDigits;
  global.formatPhoneUS = formatPhoneUS;
  global.fmtPhone = fmtPhone;
  global.bindPhoneInputs = bindPhoneInputs;
})(typeof window !== 'undefined' ? window : globalThis);
