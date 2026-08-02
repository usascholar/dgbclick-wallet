// HD wallet layer: BIP39 mnemonic → BIP32 seed → BIP86 taproot keys.
// Thin, audited primitives from @scure (same maintainer as @noble); this module
// only fixes the wordlist and DigiByte-specific parameters around them.

import { mnemonicToSeedSync, generateMnemonic as bip39Generate, validateMnemonic as bip39Validate } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { assertHealthyRandom } from './rng-health.js';
import { ddTokenOutputKey } from './taproot.js';
import { encodeWitnessAddress } from './address.js';
import { p2wpkhProgramHex } from './txbuild.js';

const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// hrp per BIP-173; coin type 20 is DigiByte's SLIP-44 entry, test networks use 1.
export const HD_NETWORKS = Object.freeze({
  mainnet: Object.freeze({ hrp: 'dgb', coinType: 20 }),
  testnet: Object.freeze({ hrp: 'dgbt', coinType: 1 }),
  regtest: Object.freeze({ hrp: 'dgbrt', coinType: 1 }),
});

/** Fresh 12-word english mnemonic (128 bits from the platform CSPRNG).
 *
 * Gated on a runtime CSPRNG health check: vendor locks and code review verify
 * the FILES, but a swapped-at-runtime `getRandomValues` (the 2026 Coldcard
 * failure class) is only visible in the OUTPUT. assertHealthyRandom throws
 * rather than let a broken stream become a wallet — this is the single choke
 * point every wallet, treasury and gift key is born through. */
export function generateMnemonic() {
  assertHealthyRandom();
  return bip39Generate(wordlist, 128);
}

/** True iff the mnemonic is valid english BIP39 (wordlist + checksum). */
export function validateMnemonic(mnemonic) {
  return bip39Validate(mnemonic, wordlist);
}

/** BIP39 seed from an english mnemonic (sync PBKDF2 — fine in browser and Node). */
export function mnemonicToSeed(mnemonic, passphrase = '') {
  return mnemonicToSeedSync(mnemonic, passphrase);
}

/**
 * P2WPKH (witness v0) address of a private key: hash160 of the compressed
 * pubkey. Mint DGB change goes to this script BY CONSENSUS (single-collateral-
 * shape rule), so the wallet watches each key's P2WPKH twin alongside its P2TR.
 */
export function p2wpkhAddress(privKeyHex, hrp) {
  return encodeWitnessAddress(hrp, 0, p2wpkhProgramHex(privKeyHex));
}

/**
 * BIP86 taproot key + address at m/86'/coinType'/account'/change/index.
 * The output key is the key-path-only tap tweak — identical to Core's
 * CreateDigiDollarP2TR, so a mint to this address is redeemable by this key.
 * Also carries the key's P2WPKH twin (`p2wpkhAddress`) — change-only, never
 * shown as a receive address — so callers get it without re-deriving.
 */
export function deriveTaprootAddress(seed, { hrp, coinType, account = 0, change = 0, index = 0 }) {
  // Two key sources, one derivation contract: a BIP39 SEED (the normal case)
  // or a DESCRIPTOR source from descriptorKeySource() — a Core wallet exports
  // `tr([fp/86h/20h/0h]xprv…/0/*)`, never a mnemonic, so importing one is the
  // only migration path off Core. Callers pass whichever they hold and every
  // downstream flow (addresses, signing, positions) is identical.
  if (seed?.__descriptor) return deriveFromDescriptor(seed, { hrp, change, index });
  const path = `m/86'/${coinType}'/${account}'/${change}/${index}`;
  const node = HDKey.fromMasterSeed(seed).derive(path);
  const internalKeyHex = bytesToHex(node.publicKey.slice(1)); // x-only: drop the parity byte
  const outputKeyHex = ddTokenOutputKey(internalKeyHex);
  const privKeyHex = bytesToHex(node.privateKey);
  return {
    path,
    privKeyHex,
    internalKeyHex,
    outputKeyHex,
    address: encodeWitnessAddress(hrp, 1, outputKeyHex),
    p2wpkhAddress: p2wpkhAddress(privKeyHex, hrp),
  };
}

// ---- Descriptor key source (Core migration) ----
// DigiByte Core wallets have no BIP39 mnemonic to hand over — they export
// DESCRIPTORS (`listdescriptors true`). Accepting one makes Diginaut a real
// destination for Core users: paste the private tr() descriptor and every
// address, signature and position works exactly as a seeded wallet's does.
//
// Shapes handled (checksum optional, 'h' and "'" both fine):
//   tr([abc12345/86h/20h/0h]xprv…/0/*)#checksum   ← Core's account-level export
//   tr(xprv…/86h/20h/0h/0/*)                      ← master key, full path inline
//   tr(xprv…)                                     ← single key, no wildcard
// The extended key is derived by the RELATIVE path after it, so both the
// account-level and master-level shapes work through one code path.
const DESC_RE = /^(tr|wpkh)\(\s*(?:\[([0-9a-fA-F]{8}(?:\/[0-9]+['hH]?)*)\]\s*)?([tx]prv[1-9A-HJ-NP-Za-km-z]+)((?:\/[0-9*]+['hH]?)*)\s*\)(?:#[a-z0-9]+)?$/; // checksum length is not enforced: the KEY is what we validate

/**
 * Parse a private tr() descriptor.
 * @returns {{ extendedKey: string, relPath: string, origin: string|null, hasWildcard: boolean }}
 */
export function parseTrDescriptor(desc) {
  const text = String(desc ?? '').trim();
  if (!text) throw new RangeError('paste the descriptor from Core: listdescriptors true');
  if (/\b[tx]pub/.test(text) && !/[tx]prv/.test(text)) {
    throw new RangeError('that is a WATCH-ONLY descriptor (xpub). Diginaut needs the PRIVATE one — run `listdescriptors true` (with true) in Core');
  }
  const m = text.match(DESC_RE);
  if (!m) {
    if (/^(pkh|sh|wsh|combo)\(/.test(text)) throw new RangeError('that address type is not supported here — Diginaut handles taproot tr(…) and native segwit wpkh(…); move funds off legacy addresses inside Core first');
    throw new RangeError('could not read that as a tr(…) descriptor — copy one whole line from `listdescriptors true`');
  }
  const [, kind, origin = null, extendedKey, tail = ''] = m;
  const relPath = tail.replace(/^\//, '');
  return { kind, extendedKey, relPath, origin, hasWildcard: relPath.includes('*') };
}

/** Turn a descriptor into a key source deriveTaprootAddress() accepts. */
export function descriptorKeySource(desc) {
  const parsed = parseTrDescriptor(desc);
  HDKey.fromExtendedKey(parsed.extendedKey); // fail fast on a corrupt key
  return { __descriptor: true, ...parsed };
}

function deriveFromDescriptor(source, { hrp, change, index }) {
  const root = HDKey.fromExtendedKey(source.extendedKey);
  if (!root.privateKey) throw new RangeError('that descriptor carries no private key — Diginaut cannot sign with it');
  // `*` is the address index. The descriptor's OWN chain element is honored as
  // written and never rewritten from `change`: Core exports one descriptor per
  // chain (`…/0/*` and `…/1/*`), so substituting would collapse both onto the
  // same chain — deriving identical addresses twice and double-counting the
  // balance (caught in test: one 15 DGB coin read as 30).
  let rel = source.relPath;
  if (source.hasWildcard) {
    const parts = rel.split('/');
    parts[parts.lastIndexOf('*')] = String(index);
    rel = parts.join('/');
  }
  const node = rel ? root.derive('m/' + rel.replace(/[hH]/g, "'")) : root;
  const internalKeyHex = bytesToHex(node.publicKey.slice(1));
  const outputKeyHex = ddTokenOutputKey(internalKeyHex);
  const privKeyHex = bytesToHex(node.privateKey);
  return {
    path: `desc:${rel || '(single key)'}`,
    privKeyHex,
    internalKeyHex,
    outputKeyHex,
    address: encodeWitnessAddress(hrp, 1, outputKeyHex),
    p2wpkhAddress: p2wpkhAddress(privKeyHex, hrp),
  };
}

/**
 * Take the WHOLE `listdescriptors true` output (JSON, or any pasted text) and
 * sort out what Diginaut can use. Core exports one descriptor per address type
 * AND per chain — pasting a single line imports a fraction of the wallet, which
 * is how a Core user ends up seeing a treasury but none of their DGB.
 *
 * Returns:
 *   primary      the taproot receive descriptor — the wallet's key source
 *                (DigiDollar, treasuries and gifting are taproot-only)
 *   extra        further PRIVATE descriptors whose coins we can also see and
 *                spend: the taproot change chain and native-segwit wpkh chains
 *   unsupported  address types we deliberately will not touch (legacy pkh,
 *                sh(wpkh) …) — reported so the user is told, not left guessing
 * @returns {{ primary: string, extra: string[], unsupported: string[] }}
 */
export function parseDescriptorBundle(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new RangeError('paste the output of `listdescriptors true` from Core');
  let candidates = [];
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let json;
    try { json = JSON.parse(raw); } catch { throw new RangeError('that JSON does not parse — paste the whole `listdescriptors true` output unmodified'); }
    const list = Array.isArray(json) ? json : (json.descriptors ?? []);
    candidates = list.map((d) => (typeof d === 'string' ? d : d?.desc)).filter(Boolean);
    if (!candidates.length) throw new RangeError('no "descriptors" array in that JSON — is it really `listdescriptors` output?');
  } else {
    candidates = raw.split(/\r?\n/).map((l) => l.trim().replace(/^["',]+|["',]+$/g, '')).filter(Boolean);
  }

  const usable = [];
  const unsupported = new Set();
  for (const desc of candidates) {
    if (!/[tx]prv/.test(desc)) continue; // watch-only line: nothing to sign with
    try {
      usable.push({ desc, ...parseTrDescriptor(desc) });
    } catch {
      const kind = desc.match(/^([a-z]+)\(/)?.[1];
      if (kind) unsupported.add(kind);
    }
  }
  if (!usable.length) {
    throw new RangeError(unsupported.size
      ? `none of those descriptors can be used here (found: ${[...unsupported].join(', ')}). Diginaut needs a taproot tr(…) descriptor — DigiDollar is taproot-only.`
      : 'no PRIVATE descriptors found — run `listdescriptors true` (with true), which is the only form that can sign');
  }
  // the receive chain (…/0/*) of the taproot descriptors is the primary key
  // source; a wallet with only change-chain taproot still works, just at /1/*
  const taproot = usable.filter((u) => u.kind === 'tr');
  if (!taproot.length) {
    throw new RangeError('no taproot tr(…) descriptor in that wallet — DigiDollar (and treasuries) need taproot keys. Create a taproot address in Core first, then export again.');
  }
  const primary = (taproot.find((u) => /(^|\/)0\/\*$/.test(u.relPath)) ?? taproot[0]).desc;
  return {
    primary,
    extra: usable.map((u) => u.desc).filter((d) => d !== primary),
    unsupported: [...unsupported],
  };
}
