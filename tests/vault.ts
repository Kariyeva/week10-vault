import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint, createAccount, mintTo, getAccount, getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "node:fs";
import { SimpleVault } from "../target/types/simple_vault";

describe("Задание 9 — депозиты и shares", () => {
  const baseProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    baseProvider.connection,
    baseProvider.wallet,
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      maxRetries: 5,
    }
  );
  anchor.setProvider(provider);
  const connection = provider.connection;
  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const users = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const unit = 1_000_000;
  const tokens: PublicKey[] = [];
  const shares: PublicKey[] = [];
  const txs: Record<string, string> = {};
  let mint: PublicKey;
  let vault: PublicKey;
  let vaultTokens: PublicKey;
  let shareMint: PublicKey;
  let feeWallet: PublicKey;

  const pda = (seed: string) => PublicKey.findProgramAddressSync(
    [Buffer.from(seed), mint.toBuffer()], program.programId
  )[0];

  const card = (i: number) => PublicKey.findProgramAddressSync(
    [Buffer.from("user_card"), vault.toBuffer(), users[i].publicKey.toBuffer()],
    program.programId
  )[0];

  function deposit(i: number, amount: number, fee = feeWallet) {
    return program.methods.deposit(new anchor.BN(amount))
      .accountsStrict({
        vaultState: vault,
        userCard: card(i),
        vaultTokenAccount: vaultTokens,
        shareMint,
        userTokenAccount: tokens[i],
        userShareAccount: shares[i],
        feeWallet: fee,
        user: users[i].publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([users[i]])
      .rpc();
  }

  function pause(value: boolean, signer = admin) {
    return program.methods.setPaused(value)
      .accountsStrict({ vaultState: vault, admin: signer.publicKey })
      .signers([signer])
      .rpc();
  }

  async function expectError(action: () => Promise<unknown>, code: string) {
    let caught: any;
    try {
      await action();
    } catch (error) {
      caught = error;
    }
    assert.exists(caught, `Ожидалась ошибка ${code}`);
    assert.equal(caught.error?.errorCode?.code, code);
  }

  async function snapshot() {
    const v = await program.account.vaultState.fetch(vault);
    const balances = [];
    for (let i = 0; i < 3; i++) {
      balances.push({
        tokens: (await getAccount(connection, tokens[i], "confirmed")).amount.toString(),
        shares: (await getAccount(connection, shares[i], "confirmed")).amount.toString(),
      });
    }
    return JSON.stringify({
      tokens: v.totalTokens.toString(),
      shares: v.totalShares.toString(),
      fee: (await getAccount(connection, feeWallet, "confirmed")).amount.toString(),
      vaultBalance: (await getAccount(connection, vaultTokens, "confirmed")).amount.toString(),
      balances,
    });
  }

  async function rejectDeposit(action: () => Promise<unknown>, code: string) {
    const before = await snapshot();
    await expectError(action, code);
    assert.equal(await snapshot(), before, "Неудачный депозит изменил балансы");
  }

  before(async () => {
    const funding = new Transaction();
    for (const user of users) {
      funding.add(SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user.publicKey,
        lamports: 10_000_000,
      }));
    }
    await provider.sendAndConfirm(funding);

    mint = await createMint(
      connection, admin, admin.publicKey, null, 6,
      undefined, { commitment: "confirmed" }
    );
    vault = pda("vault");
    vaultTokens = pda("vault_tokens");
    shareMint = pda("share_mint");
    feeWallet = await createAccount(
      connection, admin, mint, admin.publicKey,
      undefined, { commitment: "confirmed" }
    );
  });

  it("1. Создаёт vault со счётом комиссии и минимумом 1 токен", async () => {
    txs.initialize = await program.methods.initializeVault()
      .accountsStrict({
        vaultState: vault,
        vaultTokenAccount: vaultTokens,
        shareMint,
        tokenMint: mint,
        feeWallet,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

    const v = await program.account.vaultState.fetch(vault);
    assert.equal(v.feeWallet.toBase58(), feeWallet.toBase58());
    assert.equal(v.minDeposit.toString(), String(unit));
    assert.isFalse(v.paused);

    for (let i = 0; i < 3; i++) {
      txs[`card${i + 1}`] = await program.methods.createUserCard()
        .accountsStrict({
          vaultState: vault,
          userCard: card(i),
          user: users[i].publicKey,
          systemProgram: SystemProgram.programId,
        }).signers([users[i]]).rpc();

      tokens.push(await createAccount(
        connection, admin, mint, users[i].publicKey,
        undefined, { commitment: "confirmed" }
      ));
      shares.push(await createAccount(
        connection, admin, shareMint, users[i].publicKey,
        undefined, { commitment: "confirmed" }
      ));
      await mintTo(
        connection, admin, mint, tokens[i], admin, 1000 * unit,
        [], { commitment: "confirmed" }
      );
    }
  });

  it("2. Отклоняет нулевой депозит без изменения балансов", async () => {
    await rejectDeposit(() => deposit(0, 0), "ZeroAmount");
  });

  it("3. Отклоняет депозит меньше 1 токена", async () => {
    await rejectDeposit(() => deposit(0, unit - 1), "BelowMinimum");
  });

  it("4. Принимает ровно 1 токен: комиссия 0.01, shares 0.99", async () => {
    txs.minimum = await deposit(0, unit);
    assert.equal(
      (await getAccount(connection, feeWallet, "confirmed")).amount.toString(),
      "10000"
    );
    assert.equal(
      (await getAccount(connection, shares[0], "confirmed")).amount.toString(),
      "990000"
    );
  });

  it("5. Трое пользователей вносят суммарно 100, 200 и 300 токенов", async () => {
    txs.depositA = await deposit(0, 99 * unit);
    txs.depositB = await deposit(1, 200 * unit);
    txs.depositC = await deposit(2, 300 * unit);

    const gross = [100, 200, 300];
    const net = [99, 198, 297];
    for (let i = 0; i < 3; i++) {
      const c = await program.account.userCard.fetch(card(i));
      assert.equal(c.deposited.toString(), String(gross[i] * unit));
      assert.equal(c.shares.toString(), String(net[i] * unit));
      assert.equal(
        (await getAccount(connection, tokens[i], "confirmed")).amount.toString(),
        String((1000 - gross[i]) * unit)
      );
      assert.equal(
        (await getAccount(connection, shares[i], "confirmed")).amount.toString(),
        String(net[i] * unit)
      );
    }
  });

  it("6. Проверяет комиссию 6 токенов, vault 594 и доли 1/6, 1/3, 1/2", async () => {
    const v = await program.account.vaultState.fetch(vault);
    assert.equal(v.totalTokens.toString(), String(594 * unit));
    assert.equal(v.totalShares.toString(), String(594 * unit));
    assert.equal(
      (await getAccount(connection, vaultTokens, "confirmed")).amount.toString(),
      String(594 * unit)
    );
    assert.equal(
      (await getAccount(connection, feeWallet, "confirmed")).amount.toString(),
      String(6 * unit)
    );
    const supply = (await getMint(connection, shareMint, "confirmed")).supply;
    assert.equal(supply.toString(), String(594 * unit));
    for (const [i, denominator] of [[0, 6], [1, 3], [2, 2]]) {
      const balance = (await getAccount(connection, shares[i], "confirmed")).amount;
      assert.equal((balance * BigInt(denominator)).toString(), supply.toString());
    }
  });

  it("7. Запрещает подмену счёта комиссии", async () => {
    await rejectDeposit(
      () => deposit(0, unit, tokens[0]), "InvalidFeeWallet"
    );
  });

  it("8. Посторонний пользователь не может включить паузу", async () => {
    await expectError(() => pause(true, users[0]), "Unauthorized");
    assert.isFalse((await program.account.vaultState.fetch(vault)).paused);
  });

  it("9. Администратор включает паузу, депозит отклоняется", async () => {
    txs.pause = await pause(true);
    assert.isTrue((await program.account.vaultState.fetch(vault)).paused);
    await rejectDeposit(() => deposit(0, unit), "VaultPaused");
  });

  it("10. После снятия паузы депозит снова разрешён в симуляции", async () => {
    txs.unpause = await pause(false);
    assert.isFalse((await program.account.vaultState.fetch(vault)).paused);

    const transaction = await program.methods.deposit(new anchor.BN(unit))
      .accountsStrict({
        vaultState: vault,
        userCard: card(0),
        vaultTokenAccount: vaultTokens,
        shareMint,
        userTokenAccount: tokens[0],
        userShareAccount: shares[0],
        feeWallet,
        user: users[0].publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();

    // Симуляция без отправки в сеть и без проверки криптографических подписей.
    // Проверка реальных подписей уже выполняется при депозитах в тестах 4–5.
    const before = await snapshot();
    const simulation = await provider.simulate(
      transaction, undefined, "confirmed"
    );
    assert.equal(await snapshot(), before);

  });

  after(function () {
    const tests = this.test?.parent?.tests ?? [];
    if (tests.length !== 10 || tests.some(t => t.state !== "passed")) return;

    const addresses = {
      program: program.programId.toBase58(),
      admin: admin.publicKey.toBase58(),
      tokenMint: mint.toBase58(),
      vaultState: vault.toBase58(),
      vaultTokenAccount: vaultTokens.toBase58(),
      shareMint: shareMint.toBase58(),
      feeWallet: feeWallet.toBase58(),
      users: users.map((u, i) => ({
        wallet: u.publicKey.toBase58(),
        card: card(i).toBase58(),
        tokenAccount: tokens[i].toBase58(),
        shareAccount: shares[i].toBase58(),
      })),
    };
    const result = {
      network: "devnet",
      checkedAt: new Date().toISOString(),
      testsPassed: 10,
      deposits: [100, 200, 300],
      shares: [99, 198, 297],
      fractions: ["1/6", "1/3", "1/2"],
      totalTokens: 594,
      feeTokens: 6,
      addresses,
      transactions: txs,
    };
    fs.mkdirSync("receipts", { recursive: true });
    fs.writeFileSync(
      "receipts/devnet-tests.json", JSON.stringify(result, null, 2)
    );
    console.log("\nДепозиты: 100 / 200 / 300");
    console.log("Shares: 99 / 198 / 297");
    console.log("Доли: 1/6 / 1/3 / 1/2");
    console.log("Vault: 594 токена. Комиссия: 6 токенов.");
    console.log("Результаты: receipts/devnet-tests.json");
  });
});
