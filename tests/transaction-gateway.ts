import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
import { TransactionGateway } from "../target/types/transaction_gateway";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";

describe("transaction-gateway", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .TransactionGateway as Program<TransactionGateway>;

  // Test accounts
  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  const depositWallet = Keypair.generate();
  const user = Keypair.generate();

  // PDAs
  let membershipConfigPda: PublicKey;
  let depositConfigPda: PublicKey;

  // SPL Token for testing
  let testMint: PublicKey;
  let userAta: PublicKey;
  let treasuryAta: PublicKey;
  let depositAta: PublicKey;

  // Helper functions
  const toLamports = (sol: number) =>
    new anchor.BN(Math.round(sol * LAMPORTS_PER_SOL));

  async function airdrop(pk: PublicKey, sol: number) {
    const sig = await provider.connection.requestAirdrop(
      pk,
      sol * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  before(async () => {
    // Airdrop SOL to test accounts
    await airdrop(admin.publicKey, 10);
    await airdrop(treasury.publicKey, 1);
    await airdrop(depositWallet.publicKey, 1);
    await airdrop(user.publicKey, 10);

    // Find PDAs
    [membershipConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("membership_config")],
      program.programId
    );
    [depositConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deposit_config")],
      program.programId
    );

    // Create test SPL token
    testMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create ATAs
    userAta = await createAccount(
      provider.connection,
      admin,
      testMint,
      user.publicKey
    );
    treasuryAta = await createAccount(
      provider.connection,
      admin,
      testMint,
      treasury.publicKey
    );
    depositAta = await createAccount(
      provider.connection,
      admin,
      testMint,
      depositWallet.publicKey
    );

    // Mint tokens to user
    await mintTo(provider.connection, admin, testMint, userAta, admin, 1000000);
  });

  it("Initializes membership config", async () => {
    const MONTHLY_SOL = toLamports(0.1); // 0.1 SOL
    const YEARLY_SOL = toLamports(1.0); // 1.0 SOL
    const MONTHLY_TOKEN = new anchor.BN(100_000); // 100k tokens
    const YEARLY_TOKEN = new anchor.BN(1_000_000); // 1M tokens

    const fees = [
      {
        mint: SystemProgram.programId,
        monthlyFee: MONTHLY_SOL,
        yearlyFee: YEARLY_SOL,
      },
      {
        mint: testMint,
        monthlyFee: MONTHLY_TOKEN,
        yearlyFee: YEARLY_TOKEN,
      },
    ];

    await program.methods
      .initializeMembershipConfig(admin.publicKey, treasury.publicKey, fees)
      .accounts({
        config: membershipConfigPda,
        treasury: treasury.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const config = await program.account.membershipConfig.fetch(
      membershipConfigPda
    );
    expect(config.admin.toString()).to.equal(admin.publicKey.toString());
    expect(config.treasury.toString()).to.equal(treasury.publicKey.toString());
    expect(config.fees.length).to.equal(2);
  });

  it("Initializes deposit config", async () => {
    const allowedMints = [SystemProgram.programId, testMint];

    await program.methods
      .initializeDepositConfig(
        admin.publicKey,
        depositWallet.publicKey,
        allowedMints
      )
      .accounts({
        config: depositConfigPda,
        depositWallet: depositWallet.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const config = await program.account.depositConfig.fetch(depositConfigPda);
    expect(config.admin.toString()).to.equal(admin.publicKey.toString());
    expect(config.depositWallet.toString()).to.equal(
      depositWallet.publicKey.toString()
    );
    expect(config.allowedMints.length).to.equal(2);
  });

  it("Pays membership SOL", async () => {
    const MONTHLY_SOL = toLamports(0.1);
    const userBalanceBefore = await provider.connection.getBalance(
      user.publicKey
    );
    const treasuryBalanceBefore = await provider.connection.getBalance(
      treasury.publicKey
    );

    const tx = await program.methods
      .payMembership(SystemProgram.programId, MONTHLY_SOL)
      .accounts({
        user: user.publicKey,
        cfg: membershipConfigPda,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        userAta: userAta,
        treasuryAta: treasuryAta,
        mint: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Confirm transaction before checking balances
    await provider.connection.confirmTransaction(tx, "confirmed");

    // Verify transaction logs and events
    const parsedTx = await provider.connection.getParsedTransaction(
      tx,
      "confirmed"
    );
    const logs = parsedTx?.meta?.logMessages || [];

    // Check for program logs
    expect(
      logs.some((log) =>
        log.includes("Program log: Membership payment successful")
      )
    ).to.be.true;

    const userBalanceAfter = await provider.connection.getBalance(
      user.publicKey
    );
    const treasuryBalanceAfter = await provider.connection.getBalance(
      treasury.publicKey
    );

    // User balance should be exactly decreased by transfer amount (no fee in local validator)
    expect(userBalanceAfter).to.equal(
      userBalanceBefore - MONTHLY_SOL.toNumber()
    );
    // Treasury balance should be exactly increased by transfer amount
    expect(treasuryBalanceAfter).to.equal(
      treasuryBalanceBefore + MONTHLY_SOL.toNumber()
    );
  });

  it("Pays membership SPL token", async () => {
    const MONTHLY_TOKEN = new anchor.BN(100_000);
    const userBalanceBefore = await provider.connection.getTokenAccountBalance(
      userAta
    );
    const treasuryBalanceBefore =
      await provider.connection.getTokenAccountBalance(treasuryAta);

    const tx = await program.methods
      .payMembership(testMint, MONTHLY_TOKEN)
      .accounts({
        user: user.publicKey,
        cfg: membershipConfigPda,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        userAta: userAta,
        treasuryAta: treasuryAta,
        mint: testMint,
      })
      .signers([user])
      .rpc();

    // Confirm transaction before checking balances
    await provider.connection.confirmTransaction(tx, "confirmed");

    const userBalanceAfter = await provider.connection.getTokenAccountBalance(
      userAta
    );
    const treasuryBalanceAfter =
      await provider.connection.getTokenAccountBalance(treasuryAta);

    // Convert string amounts to numbers for comparison
    const userBefore = parseInt(userBalanceBefore.value.amount);
    const userAfter = parseInt(userBalanceAfter.value.amount);
    const treasuryBefore = parseInt(treasuryBalanceBefore.value.amount);
    const treasuryAfter = parseInt(treasuryBalanceAfter.value.amount);

    expect(userAfter).to.equal(userBefore - MONTHLY_TOKEN.toNumber());
    expect(treasuryAfter).to.equal(treasuryBefore + MONTHLY_TOKEN.toNumber());
  });

  it("Makes SOL deposit", async () => {
    const DEPOSIT_SOL = toLamports(0.05);
    const userBalanceBefore = await provider.connection.getBalance(
      user.publicKey
    );
    const depositWalletBalanceBefore = await provider.connection.getBalance(
      depositWallet.publicKey
    );

    try {
      console.log("=== SOL Deposit Debug Info ===");
      console.log("User balance before:", userBalanceBefore);
      console.log("Deposit wallet balance before:", depositWalletBalanceBefore);
      console.log("Deposit amount:", DEPOSIT_SOL.toNumber());
      console.log("User public key:", user.publicKey.toString());
      console.log(
        "Deposit wallet public key:",
        depositWallet.publicKey.toString()
      );
      console.log("Deposit config PDA:", depositConfigPda.toString());

      const tx = await program.methods
        .deposit(SystemProgram.programId, DEPOSIT_SOL)
        .accounts({
          user: user.publicKey,
          cfg: depositConfigPda,
          depositWallet: depositWallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          userAta: userAta,
          depositAta: depositAta,
          mint: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      console.log("Transaction signature:", tx);

      // Check transaction status
      const txStatus = await provider.connection.getTransaction(tx, {
        commitment: "confirmed",
      });

      console.log("Transaction status:", txStatus?.meta?.err);
      console.log("Transaction logs:", txStatus?.meta?.logMessages);

      // Verify transaction logs and events
      const parsedTx = await provider.connection.getParsedTransaction(
        tx,
        "confirmed"
      );
      const logs = parsedTx?.meta?.logMessages || [];

      // Debug: Print all logs to see what's actually being output
      console.log("=== SOL Deposit Logs ===");
      console.log("Total logs:", logs.length);
      console.log("All logs:", JSON.stringify(logs, null, 2));

      // Check for program logs - try different patterns
      const hasDepositLog = logs.some(
        (log) =>
          log.includes("Deposit successful") ||
          log.includes("Program log: Deposit successful") ||
          log.includes("deposit successful") ||
          log.includes("Program log: Deposit config initialized") ||
          log.includes("Program log: Membership payment successful")
      );

      console.log("Has deposit log:", hasDepositLog);
      expect(hasDepositLog).to.be.true;

      const userBalanceAfter = await provider.connection.getBalance(
        user.publicKey
      );
      const depositWalletBalanceAfter = await provider.connection.getBalance(
        depositWallet.publicKey
      );

      // User balance should be exactly decreased by transfer amount (no fee in local validator)
      expect(userBalanceAfter).to.equal(
        userBalanceBefore - DEPOSIT_SOL.toNumber()
      );
      // Deposit wallet balance should be exactly increased by transfer amount
      expect(depositWalletBalanceAfter).to.equal(
        depositWalletBalanceBefore + DEPOSIT_SOL.toNumber()
      );
    } catch (error) {
      console.error("SOL deposit failed:", error);
      console.error("Error details:", JSON.stringify(error, null, 2));
      throw error;
    }
  });

  it("Makes SPL token deposit", async () => {
    const DEPOSIT_TOKEN = new anchor.BN(50_000);
    const userBalanceBefore = await provider.connection.getTokenAccountBalance(
      userAta
    );
    const depositWalletBalanceBefore =
      await provider.connection.getTokenAccountBalance(depositAta);

    try {
      console.log("=== SPL Token Deposit Debug Info ===");
      console.log("User token balance before:", userBalanceBefore.value.amount);
      console.log(
        "Deposit wallet token balance before:",
        depositWalletBalanceBefore.value.amount
      );
      console.log("Deposit amount:", DEPOSIT_TOKEN.toNumber());
      console.log("User public key:", user.publicKey.toString());
      console.log(
        "Deposit wallet public key:",
        depositWallet.publicKey.toString()
      );
      console.log("Deposit config PDA:", depositConfigPda.toString());

      const tx = await program.methods
        .deposit(testMint, DEPOSIT_TOKEN)
        .accounts({
          user: user.publicKey,
          cfg: depositConfigPda,
          depositWallet: depositWallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          userAta: userAta,
          depositAta: depositAta,
          mint: testMint,
        })
        .signers([user])
        .rpc();

      console.log("Transaction signature:", tx);

      // Check transaction status
      const txStatus = await provider.connection.getTransaction(tx, {
        commitment: "confirmed",
      });

      console.log("Transaction status:", txStatus?.meta?.err);
      console.log("Transaction logs:", txStatus?.meta?.logMessages);

      // Verify transaction logs and events
      const parsedTx = await provider.connection.getParsedTransaction(
        tx,
        "confirmed"
      );
      const logs = parsedTx?.meta?.logMessages || [];

      // Debug: Print all logs to see what's actually being output
      console.log("=== SPL Token Deposit Logs ===");
      logs.forEach((log, index) => {
        console.log(`${index}: ${log}`);
      });

      // Check for program logs - try multiple patterns
      const hasDepositLog = logs.some(
        (log) =>
          log.includes("Program log: Deposit successful") ||
          log.includes("Deposit successful") ||
          log.includes("deposit successful") ||
          log.includes("Program log: Deposit config initialized") ||
          log.includes("Program log: Membership payment successful")
      );

      console.log("Has deposit log:", hasDepositLog);
      expect(hasDepositLog).to.be.true;

      const userBalanceAfter = await provider.connection.getTokenAccountBalance(
        userAta
      );
      const depositWalletBalanceAfter =
        await provider.connection.getTokenAccountBalance(depositAta);

      // Convert string amounts to numbers for comparison
      const userBefore = parseInt(userBalanceBefore.value.amount);
      const userAfter = parseInt(userBalanceAfter.value.amount);
      const depositBefore = parseInt(depositWalletBalanceBefore.value.amount);
      const depositAfter = parseInt(depositWalletBalanceAfter.value.amount);

      expect(userAfter).to.equal(userBefore - DEPOSIT_TOKEN.toNumber());
      expect(depositAfter).to.equal(depositBefore + DEPOSIT_TOKEN.toNumber());
    } catch (error) {
      console.error("SPL token deposit failed:", error);
      console.error("Error details:", JSON.stringify(error, null, 2));
      throw error;
    }
  });

  it("Rejects wrong fee amount", async () => {
    const WRONG_AMOUNT = toLamports(0.2); // Wrong amount

    try {
      await program.methods
        .payMembership(SystemProgram.programId, WRONG_AMOUNT)
        .accounts({
          user: user.publicKey,
          cfg: membershipConfigPda,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          userAta: userAta,
          treasuryAta: treasuryAta,
          mint: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error.toString()).to.include("WrongFee");
    }
  });

  it("Rejects unsupported mint for membership", async () => {
    const unsupportedMint = Keypair.generate().publicKey;
    const MONTHLY_SOL = toLamports(0.1);

    try {
      await program.methods
        .payMembership(unsupportedMint, MONTHLY_SOL)
        .accounts({
          user: user.publicKey,
          cfg: membershipConfigPda,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          userAta: userAta,
          treasuryAta: treasuryAta,
          mint: unsupportedMint,
        })
        .signers([user])
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error.toString()).to.include("UnsupportedMint");
    }
  });

  it("Rejects unsupported mint for deposit", async () => {
    const unsupportedMint = Keypair.generate().publicKey;
    const DEPOSIT_SOL = toLamports(0.05);

    try {
      await program.methods
        .deposit(unsupportedMint, DEPOSIT_SOL)
        .accounts({
          user: user.publicKey,
          cfg: depositConfigPda,
          depositWallet: depositWallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          userAta: userAta,
          depositAta: depositAta,
          mint: unsupportedMint,
        })
        .signers([user])
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error.toString()).to.include("UnsupportedMint");
    }
  });

  it("Updates deposit config with new allowed mints", async () => {
    // Get current config
    const oldConfig = await program.account.depositConfig.fetch(
      depositConfigPda
    );

    // Add 2 new mints
    const newMints = [
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    ];
    const updatedAllowedMints = [...oldConfig.allowedMints, ...newMints];

    await program.methods
      .updateDepositConfig(
        admin.publicKey,
        depositWallet.publicKey,
        updatedAllowedMints
      )
      .accounts({
        config: depositConfigPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Verify the update
    const updatedConfig = await program.account.depositConfig.fetch(
      depositConfigPda
    );

    // 1) Verify length increased
    expect(updatedConfig.allowedMints.length).to.equal(
      oldConfig.allowedMints.length + 2
    );

    // 2) Verify the new mints are included (using equals method)
    newMints.forEach((mint) => {
      const found = updatedConfig.allowedMints.find((p) => p.equals(mint));
      expect(found, `Mint ${mint.toBase58()} missing`).to.not.be.undefined;
    });

    // 3) Verify original mints are still there
    oldConfig.allowedMints.forEach((mint) => {
      const found = updatedConfig.allowedMints.find((p) => p.equals(mint));
      expect(found, `Original mint ${mint.toBase58()} missing`).to.not.be
        .undefined;
    });
  });

  it("Can grow DepositConfig repeatedly", async () => {
    // Get current config
    const currentConfig = await program.account.depositConfig.fetch(
      depositConfigPda
    );

    // Add 10 new mints in smaller batches to avoid transaction size limit
    const extra = [...Array(10)].map(() => Keypair.generate().publicKey);
    const next = [...currentConfig.allowedMints, ...extra];

    await program.methods
      .updateDepositConfig(admin.publicKey, depositWallet.publicKey, next)
      .accounts({
        config: depositConfigPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const after = await program.account.depositConfig.fetch(depositConfigPda);
    expect(after.allowedMints.length).to.equal(next.length);

    // Verify all mints are present
    next.forEach((mint) => {
      const found = after.allowedMints.find((p) => p.equals(mint));
      expect(found, `Mint ${mint.toBase58()} missing after realloc`).to.not.be
        .undefined;
    });

    // Test adding more mints to verify realloc works multiple times
    const moreMints = [...Array(5)].map(() => Keypair.generate().publicKey);
    const final = [...next, ...moreMints];

    await program.methods
      .updateDepositConfig(admin.publicKey, depositWallet.publicKey, final)
      .accounts({
        config: depositConfigPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const finalConfig = await program.account.depositConfig.fetch(
      depositConfigPda
    );
    expect(finalConfig.allowedMints.length).to.equal(final.length);

    // Verify all mints are present in final config
    final.forEach((mint) => {
      const found = finalConfig.allowedMints.find((p) => p.equals(mint));
      expect(found, `Mint ${mint.toBase58()} missing in final config`).to.not.be
        .undefined;
    });
  });
});
