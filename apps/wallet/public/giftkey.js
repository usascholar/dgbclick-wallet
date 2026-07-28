// "Make a Gift key" helper — for DigiByte CORE wallet users who want to
// RECEIVE a gifted (mint-to-order) treasury without running Diginaut.
//
// A gift must name the recipient's RAW x-only owner key, and no address can
// carry it (addresses hold its one-way tweak). Core exposes the raw key in
// getaddressinfo's tr() descriptor; this helper turns that pasted output into
// a checksummed ddgift1… Gift key plus the derived DD address for
// cross-checking — entirely client-side, no wallet needed, nothing leaves the
// browser. Recipe + regtest proof: docs/discovery/core-recipient-gift-findings.md.
//
// Dependency-free like treasuries.js (node:test imports this directly); the
// lib encoders arrive via injection from app.js.

/**
 * Extract the raw x-only owner key from whatever a Core user pastes:
 *  - full `getaddressinfo` JSON (uses .desc, and .witness_program when present
 *    so the caller can verify the tweak)
 *  - just the desc line:  tr([origin]KEY)#checksum
 *  - a bare key: 64-hex (x-only) or 66-hex compressed (02/03 prefix dropped)
 * Throws plain-language errors — including the teaching case where someone
 * pastes an ADDRESS, which cryptographically cannot work.
 * @returns {{ rawKeyHex: string, witnessProgramHex: string|null }}
 */
export function parseRawOwnerKey(text) {
  const input = String(text ?? '').trim();
  if (!input) throw new Error('paste the output of getaddressinfo (or the tr(…) desc line) first');

  let desc = input;
  let witnessProgramHex = null;
  if (input.startsWith('{')) {
    let json;
    try { json = JSON.parse(input); } catch { throw new Error('that JSON does not parse — paste the full getaddressinfo output unmodified'); }
    desc = json.desc ?? '';
    witnessProgramHex = /^[0-9a-fA-F]{64}$/.test(json.witness_program ?? '') ? json.witness_program.toLowerCase() : null;
    if (!desc) throw new Error('no "desc" field in that JSON — is it really getaddressinfo output? (needs a descriptor wallet)');
  }

  const trKey = desc.match(/tr\((?:\[[^\]]*\])?([0-9a-fA-F]{64,66})[),\/]/)?.[1];
  const bare = trKey ?? (/^[0-9a-fA-F]{64}$|^0[23][0-9a-fA-F]{64}$/.test(desc) ? desc : null);
  if (!bare) {
    if (/^(dgb|dgbt|dgbrt)1|^(DD|TD|RD)[1-9a-km-zA-HJ-NP-Z]/.test(desc)) {
      throw new Error('that is an ADDRESS — an address cannot make a Gift key (it holds a one-way tweak '
        + 'of the owner key). Run `getaddressinfo <your dgb1p… address>` in your Core wallet and paste THAT output.');
    }
    throw new Error('no owner key found — expected getaddressinfo JSON, a tr(…) descriptor, or a 64/66-hex pubkey');
  }
  const rawKeyHex = (bare.length === 66 ? bare.slice(2) : bare).toLowerCase();
  return { rawKeyHex, witnessProgramHex };
}

/** Wire the modal. deps = { encodeGiftKey, ddTokenOutputKey, encodeDDAddress }
 * injected by app.js. Safe with no wallet and pre-unlock. */
export function initGiftKeyHelper({ $, netName, deps }) {
  const open = () => {
    $('gk-input').value = '';
    $('gk-err').textContent = '';
    $('gk-result').style.display = 'none';
    $('giftkey-modal').classList.add('open');
  };
  $('hero-giftkey').addEventListener('click', open);
  $('giftkey-modal').querySelector('[data-close]').addEventListener('click', () => $('giftkey-modal').classList.remove('open'));

  $('gk-make').addEventListener('click', () => {
    $('gk-err').textContent = '';
    $('gk-result').style.display = 'none';
    try {
      const network = netName();
      if (!network) throw new Error('still connecting to the node — try again in a moment');
      const { rawKeyHex, witnessProgramHex } = parseRawOwnerKey($('gk-input').value);
      const derivedProgram = deps.ddTokenOutputKey(rawKeyHex);
      // when the paste carried the address program, PROVE the recipe on the spot
      if (witnessProgramHex && witnessProgramHex !== derivedProgram) {
        throw new Error('the key in that desc does not match its own address — paste the full, '
          + 'unmodified getaddressinfo output for one of YOUR addresses');
      }
      $('gk-out-key').textContent = deps.encodeGiftKey(rawKeyHex, network);
      $('gk-out-addr').textContent = deps.encodeDDAddress(derivedProgram, network);
      $('gk-verified').textContent = witnessProgramHex
        ? '✓ verified: this key matches the pasted address'
        : 'Cross-check: the DigiDollar address below must appear in your own wallet (listdigidollaraddresses).';
      $('gk-result').style.display = 'block';
    } catch (err) {
      $('gk-err').textContent = err.message;
    }
  });
}
