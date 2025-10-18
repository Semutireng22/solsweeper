const bs58 = require("bs58"); // v5
const nacl = require("tweetnacl");
require("dotenv").config();

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

// ===== Konfigurasi hardcode =====
const RPC_HTTP = "https://api.mainnet-beta.solana.com";
const RPC_WS = "wss://api.mainnet-beta.solana.com";

const MIN_TRIGGER_SOL = 0.3;      // threshold minimal
const POLL_INTERVAL_MS = 15_000;  // polling fallback tiap 15 detik
// ================================

function loadKeypairFromEnv() {
  const b58 = process.env.PHANTOM_KEY_B58 && process.env.PHANTOM_KEY_B58.trim();
  if (!b58) throw new Error("PHANTOM_KEY_B58 belum di-set di .env");

  let raw;
  try {
    raw = bs58.decode(b58);
  } catch (e) {
    throw new Error("PHANTOM_KEY_B58 tidak valid (base58 decode gagal)");
  }

  if (raw.length === 64) {
    return Keypair.fromSecretKey(raw);
  }
  if (raw.length === 32) {
    const kp = nacl.sign.keyPair.fromSeed(raw);
    return Keypair.fromSecretKey(kp.secretKey);
  }
  throw new Error(
    `Ukuran key tidak didukung: ${raw.length} byte. Harus 32 (seed) atau 64 (secretKey).`
  );
}

function toSol(lamports) {
  return lamports / LAMPORTS_PER_SOL;
}

async function getBalance(conn, pubkey) {
  return await conn.getBalance(pubkey); // tanpa commitment -> default
}

async function sweepAll(conn, payer, destPubkey) {
  // Hitung amount = saldo - fee (menguras)
  const balance = await getBalance(conn, payer.publicKey);
  if (balance <= 0) {
    console.log("Saldo 0, batal sweep.");
    return null;
  }

  // Buat TX dummy untuk hitung fee
  const ix = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: destPubkey,
    lamports: 0, // sementara 0; kita hitung fee dulu
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const txForFee = new Transaction({
    recentBlockhash: blockhash,
    feePayer: payer.publicKey,
  }).add(ix);

  // fee yang dibutuhkan untuk 1 signature
  const { value: feeLamports } = await conn.getFeeForMessage(
    txForFee.compileMessage()
  );

  const amount = balance - feeLamports;
  if (amount <= 0) {
    console.log(
      `Saldo ${toSol(balance)} SOL tidak cukup menutup fee ${toSol(
        feeLamports
      )} SOL. Menunggu top-up berikutnya.`
    );
    return null;
  }

  // Buat TX final dengan amount sebenarnya
  const ixFinal = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: destPubkey,
    lamports: amount,
  });

  const { blockhash: bh2 } = await conn.getLatestBlockhash();
  const tx = new Transaction({
    recentBlockhash: bh2,
    feePayer: payer.publicKey,
  }).add(ixFinal);

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    skipPreflight: false,
  });

  console.log(
    `[${new Date().toISOString()}] Sweep OK: kirim ${toSol(
      amount
    )} SOL → ${destPubkey.toBase58()} | sig: ${sig}`
  );
  return sig;
}

async function main() {
  const DEST = process.env.DEST_ADDRESS && process.env.DEST_ADDRESS.trim();
  if (!DEST) throw new Error("DEST_ADDRESS belum di-set di .env");

  const destPubkey = new PublicKey(DEST);
  const payer = loadKeypairFromEnv();

  const conn = new Connection(RPC_HTTP, {
    wsEndpoint: RPC_WS,
  });

  console.log("=== SOL Auto-Sweeper ===");
  console.log("RPC HTTP:", RPC_HTTP);
  console.log("RPC WS  :", RPC_WS);
  console.log("Sumber  :", payer.publicKey.toBase58());
  console.log("Tujuan  :", destPubkey.toBase58());
  console.log("Trigger :", `>= ${MIN_TRIGGER_SOL} SOL`);
  console.log("---");

  let inProgress = false;
  let lastBalance = await getBalance(conn, payer.publicKey);
  console.log("Saldo awal:", toSol(lastBalance), "SOL");

  async function maybeSweep(trigger) {
    if (inProgress) return;
    try {
      inProgress = true;

      const bal = await getBalance(conn, payer.publicKey);
      lastBalance = bal;

      if (toSol(bal) >= MIN_TRIGGER_SOL) {
        console.log(
          `[${new Date().toISOString()}] Trigger '${trigger}': saldo ${toSol(
            bal
          )} SOL ≥ ${MIN_TRIGGER_SOL} SOL → mencoba sweep...`
        );
        await sweepAll(conn, payer, destPubkey);
      } else {
        // Di bawah target → hanya memantau
        console.log(
          `[${new Date().toISOString()}] '${trigger}': saldo ${toSol(
            bal
          )} SOL (< ${MIN_TRIGGER_SOL}) — memantau`
        );
      }
    } catch (e) {
      console.error("Sweep error:", e.message || e);
    } finally {
      inProgress = false;
    }
  }

  // 1) Realtime: WebSocket (onAccountChange)
  try {
    const subId = await conn.onAccountChange(
      payer.publicKey,
      async (accInfo) => {
        const newBal = accInfo.lamports;
        const delta = newBal - lastBalance;
        lastBalance = newBal;

        // Respon hanya bila ada perubahan (khususnya masuk)
        if (delta !== 0) {
          console.log(
            `[${new Date().toISOString()}] onAccountChange: delta ${toSol(
              delta
            )} SOL (saldo sekarang ${toSol(newBal)} SOL)`
          );
        }
        // Cek kondisi trigger
        if (toSol(newBal) >= MIN_TRIGGER_SOL) {
          await maybeSweep("ws");
        }
      }
    );
    console.log("WS subscription aktif. ID:", subId);
  } catch (e) {
    console.error("Gagal set WS subscription:", e.message || e);
  }

  // 2) Fallback: polling HTTP
  setInterval(async () => {
    try {
      await maybeSweep("poll");
    } catch (e) {
      console.error("Polling error:", e.message || e);
    }
  }, POLL_INTERVAL_MS);

  // Graceful shutdown
  const cleanup = async () => {
    console.log("\nShutting down...");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  console.error("Fatal:", e.message || e);
  process.exit(1);
});
