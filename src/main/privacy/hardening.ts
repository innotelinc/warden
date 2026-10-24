/**
 * Fingerprint hardening injected into the page's main world before any site
 * script runs. Values are deterministic per browsing session so a site cannot
 * use drift to identify the machine, but are generic enough not to be unique.
 *
 * Written as raw JavaScript (no template interpolation) because it is shipped
 * into the page via webFrame.executeJavaScript.
 */
export const HARDENING_SCRIPT = `(function () {
  'use strict';
  if (window.__wardenHardened) return;
  Object.defineProperty(window, '__wardenHardened', { value: true, enumerable: false });

  var seed = 0x9e3779b9;
  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  function define(obj, prop, getter) {
    try {
      Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true });
    } catch (e) {}
  }

  // --- Canvas: add sub-visible deterministic noise to readbacks ---
  function addNoise(canvas) {
    try {
      var w = Math.min(canvas.width, 96);
      var h = Math.min(canvas.height, 96);
      if (w < 1 || h < 1) return;
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      var data = ctx.getImageData(0, 0, w, h);
      for (var i = 0; i < data.data.length; i += 4) {
        var delta = rand() < 0.5 ? -1 : 1;
        data.data[i] = Math.max(0, Math.min(255, data.data[i] + delta));
      }
      ctx.putImageData(data, 0, 0);
    } catch (e) {}
  }

  try {
    var toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      addNoise(this);
      return toDataURL.apply(this, arguments);
    };
    var toBlob = HTMLCanvasElement.prototype.toBlob;
    if (toBlob) {
      HTMLCanvasElement.prototype.toBlob = function () {
        addNoise(this);
        return toBlob.apply(this, arguments);
      };
    }
    var getImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function () {
      var result = getImageData.apply(this, arguments);
      if (result && result.data) {
        for (var i = 0; i < result.data.length; i += 4) {
          result.data[i] = Math.max(0, Math.min(255, result.data[i] + (rand() < 0.5 ? -1 : 1)));
        }
      }
      return result;
    };
  } catch (e) {}

  // --- WebGL: generic renderer / vendor strings ---
  try {
    var glProto = window.WebGLRenderingContext && WebGLRenderingContext.prototype;
    if (glProto) {
      var getParameter = glProto.getParameter;
      var unmaskedRenderer = 0x9246;
      var unmaskedVendor = 0x9245;
      var renderer = 0x1f01;
      var vendor = 0x1f00;
      glProto.getParameter = function (param) {
        if (param === unmaskedRenderer) return 'ANGLE (Generic Renderer)';
        if (param === unmaskedVendor) return 'Generic Graphics';
        if (param === renderer) return 'WebKit WebGL';
        if (param === vendor) return 'WebKit';
        return getParameter.apply(this, arguments);
      };
    }
  } catch (e) {}

  // --- WebAudio: flatten analyser output ---
  try {
    if (window.AnalyserNode) {
      var getFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function (array) {
        getFloatFrequencyData.apply(this, arguments);
        if (array && array.length) {
          array[0] = array[0] + rand() * 0.0001;
        }
        return undefined;
      };
    }
  } catch (e) {}

  // --- Navigator surface ---
  define(Navigator.prototype, 'hardwareConcurrency', function () { return 4; });
  define(Navigator.prototype, 'deviceMemory', function () { return 8; });
  define(Navigator.prototype, 'webdriver', function () { return false; });
  define(Navigator.prototype, 'plugins', function () { return []; });
  define(Navigator.prototype, 'mimeTypes', function () { return []; });
  define(Navigator.prototype, 'languages', function () { return ['en-US', 'en']; });
  define(Navigator.prototype, 'doNotTrack', function () { return '1'; });
  define(Navigator.prototype, 'globalPrivacyControl', function () { return true; });

  try {
    if (navigator.connection) {
      define(navigator.connection, 'effectiveType', function () { return '4g'; });
      define(navigator.connection, 'rtt', function () { return 50; });
      define(navigator.connection, 'downlink', function () { return 10; });
    }
  } catch (e) {}

  // --- Screen rounding ---
  try {
    define(Screen.prototype, 'colorDepth', function () { return 24; });
    define(Screen.prototype, 'pixelDepth', function () { return 24; });
  } catch (e) {}

  // --- Battery / bluetooth presence ---
  try { delete Navigator.prototype.getBattery; } catch (e) {}
  try { delete Navigator.prototype.bluetooth; } catch (e) {}
})();`
