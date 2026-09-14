import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFocusButtonProps, sourceFocusStatusText } from '../../src/source-focus.js';

test('来源聚焦按钮在点击后必须呈现明确的已聚焦状态', () => {
  assert.deepEqual(sourceFocusButtonProps(false), {
    className: 'sc-reply',
    textContent: '沿航线聚焦',
    ariaPressed: 'false',
  });
  assert.deepEqual(sourceFocusButtonProps(true), {
    className: 'sc-reply is-focused',
    textContent: '已聚焦 ✓',
    ariaPressed: 'true',
  });
});

test('来源聚焦状态提供可读的即时反馈文本', () => {
  assert.equal(sourceFocusStatusText(), '点击“沿航线聚焦”可定位对应来源卡。');
  assert.equal(sourceFocusStatusText('某条回答'), '已聚焦：某条回答');
});
