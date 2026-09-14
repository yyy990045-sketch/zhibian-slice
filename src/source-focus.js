export function sourceFocusButtonProps(isFocused = false) {
  return isFocused
    ? { className: 'sc-reply is-focused', textContent: '已聚焦 ✓', ariaPressed: 'true' }
    : { className: 'sc-reply', textContent: '沿航线聚焦', ariaPressed: 'false' };
}

export function sourceFocusStatusText(title = '') {
  return title ? `已聚焦：${title}` : '点击“沿航线聚焦”可定位对应来源卡。';
}
