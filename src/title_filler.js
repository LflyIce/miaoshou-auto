async function fillProductTitles(page, titles) {
  const result = {
    productTitleFilled: false,
    englishTitleFilled: false
  };

  if (titles.japaneseTitle) {
    try {
      const locator = await locateTitleField(page, 'product');
      await fillLocatedField(locator, titles.japaneseTitle);
      result.productTitleFilled = true;
    } catch (error) {
      result.productTitleError = error.message;
    }
  }

  if (titles.englishTitle) {
    try {
      const locator = await locateTitleField(page, 'english');
      await fillLocatedField(locator, titles.englishTitle);
      result.englishTitleFilled = true;
    } catch (error) {
      result.englishTitleError = error.message;
    }
  }

  return result;
}

async function locateTitleField(page, kind) {
  const selector = await page.evaluate((targetKind) => {
    function textOf(el) {
      return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function editable(el) {
      if (el.matches('input')) {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (!['text', 'search', 'url', 'tel'].includes(type)) return false;
      }
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (/\bel-radio__original\b|\bel-checkbox__original\b/.test(`${el.className || ''}`)) return false;
      return !el.disabled && !el.readOnly && !el.closest('[aria-disabled="true"], .is-disabled, [disabled]');
    }

    function matchesKind(text) {
      if (targetKind === 'english') {
        return /英文标题|英语标题|英文|英语|english\s*title|en[_\s-]*title/i.test(text);
      }
      return /(产品标题|商品标题|标题|title)/i.test(text) && !/英文|英语|english|en[_\s-]*title/i.test(text);
    }

    function scoreControl(el) {
      const container = el.closest('.el-form-item, .ant-form-item, [class*="form-item"], tr, li, section, div');
      const labelText = textOf(container && container.querySelector('label, .el-form-item__label, .ant-form-item-label, [class*="label"]'));
      const text = [
        labelText,
        el.getAttribute('placeholder') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('name') || '',
        el.getAttribute('id') || '',
        `${el.className || ''}`,
        textOf(container).slice(0, 120)
      ].join(' ');

      if (!matchesKind(text)) return 0;

      let score = 10;
      if (targetKind === 'english' && /英文标题|英语标题|english\s*title/i.test(labelText)) score += 20;
      if (targetKind === 'product' && /产品标题|商品标题/i.test(labelText)) score += 20;
      if (/textarea/i.test(el.tagName)) score += 3;
      if ((el.value || '').length > 5) score += 2;
      return score;
    }

    const controls = Array.from(document.querySelectorAll(
      'textarea, input[type="text"], input[type="search"], input[type="url"], input[type="tel"], input:not([type])'
    ))
      .filter((el) => visible(el) && editable(el))
      .map((el) => ({ el, score: scoreControl(el) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!controls[0]) return '';
    const id = `ms-title-field-${targetKind}-${Date.now()}`;
    controls[0].el.setAttribute('data-ms-title-field', id);
    return `[data-ms-title-field="${id}"]`;
  }, kind);

  if (!selector) {
    throw new Error(kind === 'english' ? '找不到英文标题输入框' : '找不到产品标题输入框');
  }

  return page.locator(selector).first();
}

async function fillLocatedField(locator, value) {
  if (!(await locator.count())) throw new Error('找不到标题输入框');
  const fillable = await locator.evaluate((el) => {
    if (el.matches('textarea')) return true;
    if (!el.matches('input')) return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'search', 'url', 'tel'].includes(type);
  });
  if (!fillable) throw new Error('定位到的不是可填写的标题输入框');
  await locator.scrollIntoViewIfNeeded();
  await locator.fill('');
  await locator.fill(value);
  await locator.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }).catch(() => {});
}

module.exports = {
  fillProductTitles
};
