# How DGBclick Wallet generates keys, and how you can check it

A wallet is only as strong as the randomness behind its keys. If that
randomness is predictable, everything else is decoration: the funds can be
swept by anyone who works out the pattern, and no amount of encryption,
auditing, or careful UI changes that.

Recent events have put this in front of everyone. The failure mode that keeps
recurring in wallet software is not broken cryptography. It is a **silent
substitution**: the code asks for secure randomness, the secure source is
unavailable or replaced, and the software quietly carries on with something
weaker instead of stopping. Nothing looks wrong. Keys are produced. They are
just guessable.

This document explains what this wallet does, what was audited, what was found,
and, most importantly, **how to verify all of it yourself** rather than taking
our word for it.

## Why we published this

In July 2026, Coinkite disclosed that a firmware bug had reduced the entropy of
seeds generated on COLDCARD hardware wallets. We are describing it here because
it is the clearest possible statement of the problem, and because Coinkite
described it honestly in their own postmortem. It is quoted, not paraphrased.

The cause was a build-time guard that silently failed to fire. In Coinkite's
words:

> "During that migration, wallet seed generation moved from `ckcc.rng_bytes()`
> to `ngu.random.bytes()`. That path resolved `rng_get()` to MicroPython's
> software fallback instead of COLDCARD's hardware RNG implementation."

> "We defined that macro as zero, so the `#error` did not stop the build."

The result, again by Coinkite's own estimate:

> "On Mk2 and Mk3, the active PRNG was seeded primarily from device and timing
> state. Under our current attack assumptions, we estimate the effective search
> space at about 40 bits."

and about 72 bits on later models, against the 128 bits a 12-word seed is
supposed to carry. They were explicit that this was not academic:

> "For funded wallets with neither the independent dice entropy nor a strong,
> unique BIP-39 passphrase described above, the reduced search space is a direct
> security risk, not a theoretical possibility."

Two sentences from that postmortem are the reason this document exists:

> "The COLDCARD source code has always been open and publicly available, so we
> have to assume that someone used AI to review previous versions of our
> firmware and stumbled upon this issue."

> "A few weeks ago, we used one of the best available AI models to review our
> code for security issues, and it did not find this bug or anything serious."

Read that carefully, because it is the whole lesson. The code was public for
years. It was reviewed, including by a modern AI model, weeks before. The bug
survived all of it, because **reading code proves what the code says, not what
the running system does.** The build compiled. The tests passed. The function
returned bytes that looked random. Nothing was there to check whether the bytes
actually were.

That is why this wallet does not stop at "our source is open" or "it was
reviewed." It checks the generator's live output at the moment a key is created,
and it ships a script that lets you re-run the entire audit yourself, on your
machine, against the code in front of you.

We take no satisfaction in any of this. Coinkite published a root-cause
postmortem and shipped fixed firmware for every affected model within about a
day, which is a better disclosure response than most companies manage. The same
class of mistake, a fallback that engages silently instead of failing loudly,
could happen to any project, including this one. That is precisely the argument
for checks that run at generation time rather than review time.

**Sources** (retrieved 2 August 2026):
[Coldcard Security Advisory](https://blog.coinkite.com/coldcard-mk3-seed-generation-warning/),
[Technical Deep Dive into the Entropy Issue](https://blog.coinkite.com/entropy-technical-backgrounder/),
[Block engineering analysis](https://engineering.block.xyz/blog/predictable-rng-fallback-and-32-bit-reseed-in-coldcard-firmware).

A note on figures, since reporting varied: Coinkite's advisory states no theft
amount. Third-party analysts including Galaxy Research attributed a series of
sweeps between 30 July and 1 August 2026, totalling roughly 1,367 BTC across
several thousand addresses, to wallets affected by this flaw. Those figures are
theirs, they escalated as analysis continued, and as of this writing no public
report had reconstructed a specific victim's seed. We state them as attributed,
not as established cause.

## The short version

- Keys come from **`crypto.getRandomValues`**, the operating system's
  cryptographic random generator, reached through the audited `@scure/bip39`
  and `@noble/hashes` libraries.
- Each wallet is **one 16-byte draw: 128 bits of entropy**, which becomes a
  12-word seed phrase (128 bits plus a 4-bit checksum = 132 bits = 12 words).
- **There is no fallback path.** If the secure generator is missing, throws, or
  returns broken output, key generation **refuses to run**. It never degrades
  to a weaker source.
- **`Math.random` appears nowhere** in key or seed generation, in this codebase
  or anywhere in its dependency chain.
- A **runtime health gate** checks the generator's actual output at the moment
  a key is created, so a generator swapped at runtime is caught even though the
  files on disk are untouched.
- Every file the browser executes is **hash-pinned** and re-verified when the
  server starts, so the code that runs is the code that was reviewed.

## Verify it yourself

Do not trust the summary above. Run it:

```bash
git clone https://github.com/usascholar/dgbclick-wallet.git
cd dgbclick-wallet
npm ci
node scripts/verify-entropy.mjs
```

That script re-runs the audit against the code in your checkout and prints what
it measured on your machine. It exits non-zero if anything fails. It checks:

1. No `Math.random` on the key path.
2. That key generation **refuses** when the CSPRNG is missing, throwing,
   returning an untouched buffer, returning a constant, or biased. This is a
   direct simulation of the silent-substitution failure.
3. The entropy arithmetic: 128 bits end to end.
4. Measured output over thousands of real generations: all unique, bit balance
   at the ideal 0.5.
5. That derivation is deterministic (your backup restores) and that distinct
   seeds give distinct keys.
6. That the key-generation files are covered by the integrity lock.

Two more commands worth running:

```bash
npm test                # includes the RNG health gate's own test suite
npm run vendor:verify   # re-downloads the crypto libraries from npm and
                        # compares them byte for byte against the lock
```

## What was audited, and what was found

The key path was audited twice, independently: once statically, tracing the
dependency chain file by file, and once empirically, by generating keys and by
simulating the silent-substitution failure directly. Both concluded the same
thing: **128 bits, fail-closed, no fallback paths.**

The trace, if you want to follow it yourself:

| Step | Where |
|---|---|
| `generateMnemonic()` | `packages/digidollar-js/src/hd.js` |
| requests 128 bits | `@scure/bip39` calls `randomBytes(16)` |
| the actual source | `@noble/hashes/utils.js` calls `crypto.getRandomValues`, and **throws** if it is unavailable |

The arithmetic: 16 bytes = 128 bits. BIP39 adds a 4-bit checksum, giving 132
bits, which is 12 words of 11 bits each. The seed derivation (PBKDF2) stretches
those 128 bits into a 64-byte seed. Stretching and hashing **redistribute**
entropy; they never increase it. The wallet's strength is the original 128 bits,
and nothing in the pipeline reduces it.

Signature nonces were checked too, because a repeated nonce leaks a private key
just as surely as a weak seed:

- **Taproot (Schnorr, BIP340)**: the nonce is derived from the private key and
  the message, so it cannot repeat across different transactions even if the
  auxiliary randomness is poor.
- **Segwit (ECDSA)**: nonces are RFC 6979 deterministic, computed from the key
  and message with no randomness involved at all.

## What was added afterwards

The audit found no flaw in key generation. It did identify surfaces around it,
and those were closed:

**A runtime health gate.** Locks and code review verify *files*. They cannot see
a generator replaced at runtime, for instance by a malicious browser extension,
because the files on disk are untouched. So before every key is created, the
wallet now checks the generator's actual **output**: that the buffer is written,
that two draws differ, and that the bits are not catastrophically skewed. If any
check fails, key generation stops. It costs about 1.7 milliseconds.

This is deliberately a check for *broken* output, not a statistical certificate.
A small sample cannot distinguish a good generator from a sophisticated attacker,
and claiming otherwise would be exactly the false assurance we are trying to
avoid.

**Integrity coverage extended to the wallet's own code.** The dependency
libraries were hash-pinned; the wallet's own key-generation code was not. That
was backwards: an attacker able to edit the served files would not have needed
to touch a dependency at all. Now every file the browser executes, including
`hd.js` and the health gate itself, is hashed and re-verified at server start.
A mismatch **stops the server** rather than serving modified code.

**Supply-chain verification.** A hash lock proves the files match the lock; it
cannot prove the lock matches what the library authors actually published. So
`npm run vendor:verify` re-downloads each crypto library's published package and
compares it byte for byte. This is what catches a tampered file whose hash was
re-recorded to match. It runs in CI on every release and weekly.

## What this does not prove

Being clear about limits is part of being trustworthy:

- **We audited the code path, not your operating system.** If the OS or browser
  CSPRNG is itself compromised, no in-page check can detect it. This is the
  trust boundary every software wallet stands on, and we would rather say so
  than imply a guarantee we cannot make.
- **The health gate catches broken output, not clever output.** A sophisticated
  attacker who controls the generator can produce a stream that passes these
  checks. The gate raises the cost; it does not make the problem disappear.
- **Server or TLS compromise is a different threat.** If someone can replace the
  page you are served, in-page checks cannot save you. Those controls are TLS,
  server hardening, and the integrity checks above, not the RNG gate.
- **This is beta software operating on a live network.** Use it accordingly.

## If you find a problem

Please report it privately: use the **Security** tab of this repository and
click **Report a vulnerability**, so a fix can ship before the details are
public. See [SECURITY.md](../SECURITY.md).
