/* Locks a playlist login for one device (used by manage.js on /playlists/, /profiles/ and /devices/).
 * The login is sealed in the browser for each device (ECDH P-256 with the device's key → HKDF-SHA256 → AES-256-GCM);
 * Avid Viewer opens it with the private key that never leaves the device. */
(function (root) {
  'use strict';
  var INFO = 'avidviewer-playlist:v1';
  function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function unb64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }

  /** Seals {name,type,server,username,password,m3uUrl,epgUrl} for the device whose public key (raw P-256, base64) is pub. */
  async function seal(pub, obj) {
    var S = root.crypto.subtle;
    var devKey = await S.importKey('raw', unb64(pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    var eph = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    var z = await S.deriveBits({ name: 'ECDH', public: devKey }, eph.privateKey, 256);
    var epk = new Uint8Array(await S.exportKey('raw', eph.publicKey));
    var hk = await S.importKey('raw', z, 'HKDF', false, ['deriveKey']);
    var key = await S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: new TextEncoder().encode(INFO) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    var iv = root.crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
    return { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
  }
  root.AvidPlaylists = { seal: seal };
})(typeof window !== 'undefined' ? window : globalThis);
