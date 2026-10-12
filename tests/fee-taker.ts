import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";

import { FeeTaker } from "../target/types/fee_taker";

describe("FeeTaker", () => {
  // Configure the client to use the local cluster
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.FeeTaker as Program<FeeTaker>;
  const connection = anchor.getProvider().connection;

  const feeTaker = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_taker")],
    program.programId
  )[0];

  // The constant `FEE_RECIPIENT` baked into the program, read from the IDL
  // (anchor camel-cases constant names)
  const feeRecipient = new PublicKey(
    program.idl.constants.find((c) => c.name === "feeRecipient")!.value
  );

  // Fee payer / mint authority for all tests
  const payer = Keypair.generate();

  const requestId = (seed: number) => {
    const id = Buffer.alloc(32);
    id.writeUInt32BE(seed, 28);
    return Array.from(id);
  };

  const confirm = async (signature: string) => {
    await connection.confirmTransaction(signature, "confirmed");
    return signature;
  };

  const airdrop = async (to: PublicKey, lamports: number) =>
    confirm(await connection.requestAirdrop(to, lamports));

  const tokenBalance = async (account: PublicKey, tokenProgram: PublicKey) =>
    Number(
      (await getAccount(connection, account, "confirmed", tokenProgram)).amount
    );

  /**
   * Fetches the single `FeeTaken` event emitted by a confirmed transaction
   */
  const getFeeTakenEvent = async (signature: string) => {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const parser = new anchor.EventParser(program.programId, program.coder);
    const events = Array.from(parser.parseLogs(tx!.meta!.logMessages!));
    expect(events).length(1);
    expect(events[0].name).eq("feeTaken");
    return events[0].data as {
      id: number[];
      mint: PublicKey | null;
      amount: anchor.BN;
      requestedFeeAmount: anchor.BN;
      feeAmount: anchor.BN;
      remainderAmount: anchor.BN;
      feeRecipient: PublicKey;
      recipient: PublicKey;
    };
  };

  /**
   * Creates a mint plus the fee taker / fee recipient / recipient token
   * accounts, and funds the fee taker's account with `amount`
   */
  const setupToken = async (tokenProgram: PublicKey, amount: number) => {
    const recipientOwner = Keypair.generate();

    const mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      6,
      undefined,
      { commitment: "confirmed" },
      tokenProgram
    );

    const createAta = async (owner: PublicKey) => {
      // The fee taker is a PDA (off-curve), so derive with `allowOwnerOffCurve`
      const ata = getAssociatedTokenAddressSync(
        mint,
        owner,
        true,
        tokenProgram
      );
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            ata,
            owner,
            mint,
            tokenProgram
          )
        ),
        [payer],
        { commitment: "confirmed" }
      );
      return ata;
    };

    const feeTakerTokenAccount = await createAta(feeTaker);
    const feeTokenAccount = await createAta(feeRecipient);
    const recipientTokenAccount = await createAta(recipientOwner.publicKey);

    if (amount > 0) {
      await mintTo(
        connection,
        payer,
        mint,
        feeTakerTokenAccount,
        payer,
        amount,
        [],
        { commitment: "confirmed" },
        tokenProgram
      );
    }

    return {
      mint,
      feeTakerTokenAccount,
      feeTokenAccount,
      recipientTokenAccount,
      tokenProgram,
      createAta,
    };
  };

  const takeToken = (
    accounts: Awaited<ReturnType<typeof setupToken>>,
    id: number[],
    feeAmount: number,
    overrides: Partial<{
      feeRecipient: PublicKey;
      feeTokenAccount: PublicKey;
      recipientTokenAccount: PublicKey;
    }> = {}
  ) =>
    program.methods
      .takeToken(id, new anchor.BN(feeAmount))
      .accountsPartial({
        feeTaker,
        mint: accounts.mint,
        feeTakerTokenAccount: accounts.feeTakerTokenAccount,
        feeRecipient: overrides.feeRecipient ?? feeRecipient,
        feeTokenAccount: overrides.feeTokenAccount ?? accounts.feeTokenAccount,
        recipientTokenAccount:
          overrides.recipientTokenAccount ?? accounts.recipientTokenAccount,
        tokenProgram: accounts.tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc()
      .then(confirm);

  const takeNative = (
    id: number[],
    feeAmount: number,
    recipient: PublicKey,
    overrides: Partial<{ feeRecipient: PublicKey }> = {}
  ) =>
    program.methods
      .takeNative(id, new anchor.BN(feeAmount))
      .accountsPartial({
        feeTaker,
        feeRecipient: overrides.feeRecipient ?? feeRecipient,
        recipient,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
      .then(confirm);

  const expectError = async (promise: Promise<unknown>, message: string) => {
    let error: unknown;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error, "expected the transaction to fail").to.exist;
    expect(String(error)).includes(message);
  };

  before(async () => {
    await airdrop(payer.publicKey, 10 * 1e9);
  });

  describe("take_token", () => {
    it("forwards the fee and the remainder and emits the realized amounts", async () => {
      const amount = 1_000_000;
      const feeAmount = 25_000;
      const accounts = await setupToken(TOKEN_PROGRAM_ID, amount);

      const signature = await takeToken(accounts, requestId(1), feeAmount);

      expect(await tokenBalance(accounts.feeTokenAccount, TOKEN_PROGRAM_ID)).eq(
        25_000
      );
      expect(
        await tokenBalance(accounts.recipientTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(975_000);
      expect(
        await tokenBalance(accounts.feeTakerTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(0);

      const event = await getFeeTakenEvent(signature);
      expect(event.id).deep.eq(requestId(1));
      expect(event.mint!.toBase58()).eq(accounts.mint.toBase58());
      expect(event.amount.toNumber()).eq(amount);
      expect(event.requestedFeeAmount.toNumber()).eq(feeAmount);
      expect(event.feeAmount.toNumber()).eq(25_000);
      expect(event.remainderAmount.toNumber()).eq(975_000);
      expect(event.feeRecipient.toBase58()).eq(
        accounts.feeTokenAccount.toBase58()
      );
      expect(event.recipient.toBase58()).eq(
        accounts.recipientTokenAccount.toBase58()
      );
    });

    it("sends everything to the recipient when the fee exceeds the balance", async () => {
      const accounts = await setupToken(TOKEN_PROGRAM_ID, 5_000);

      const signature = await takeToken(accounts, requestId(2), 5_001);

      expect(await tokenBalance(accounts.feeTokenAccount, TOKEN_PROGRAM_ID)).eq(
        0
      );
      expect(
        await tokenBalance(accounts.recipientTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(5_000);

      const event = await getFeeTakenEvent(signature);
      expect(event.requestedFeeAmount.toNumber()).eq(5_001);
      expect(event.feeAmount.toNumber()).eq(0);
      expect(event.remainderAmount.toNumber()).eq(5_000);
    });

    it("sends everything to the fee recipient when the fee equals the balance", async () => {
      const accounts = await setupToken(TOKEN_PROGRAM_ID, 5_000);

      await takeToken(accounts, requestId(3), 5_000);

      expect(await tokenBalance(accounts.feeTokenAccount, TOKEN_PROGRAM_ID)).eq(
        5_000
      );
      expect(
        await tokenBalance(accounts.recipientTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(0);
    });

    it("sends everything to the recipient with a zero fee", async () => {
      const accounts = await setupToken(TOKEN_PROGRAM_ID, 5_000);

      await takeToken(accounts, requestId(4), 0);

      expect(await tokenBalance(accounts.feeTokenAccount, TOKEN_PROGRAM_ID)).eq(
        0
      );
      expect(
        await tokenBalance(accounts.recipientTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(5_000);
    });

    it("rejects an empty fee taker balance", async () => {
      const accounts = await setupToken(TOKEN_PROGRAM_ID, 0);

      await expectError(
        takeToken(accounts, requestId(5), 100),
        "InsufficientBalance"
      );
    });

    it("rejects a fee recipient other than the constant", async () => {
      const accounts = await setupToken(TOKEN_PROGRAM_ID, 5_000);
      const other = Keypair.generate().publicKey;
      const otherAta = await accounts.createAta(other);

      await expectError(
        takeToken(accounts, requestId(6), 100, {
          feeRecipient: other,
          feeTokenAccount: otherAta,
        }),
        "ConstraintAddress"
      );

      expect(
        await tokenBalance(accounts.feeTakerTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(5_000);
    });

    it("rejects a fee token account that is not the fee recipient's ata", async () => {
      const accounts = await setupToken(TOKEN_PROGRAM_ID, 5_000);

      await expectError(
        takeToken(accounts, requestId(7), 100, {
          feeTokenAccount: accounts.recipientTokenAccount,
        }),
        "ConstraintTokenOwner"
      );

      expect(
        await tokenBalance(accounts.feeTakerTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(5_000);
    });

    it("rejects a recipient token account of another mint", async () => {
      const accounts = await setupToken(TOKEN_PROGRAM_ID, 5_000);
      const other = await setupToken(TOKEN_PROGRAM_ID, 0);

      await expectError(
        takeToken(accounts, requestId(8), 100, {
          recipientTokenAccount: other.recipientTokenAccount,
        }),
        "ConstraintTokenMint"
      );

      expect(
        await tokenBalance(accounts.feeTakerTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(5_000);
    });

    it("leaves the fee taker token account open and reusable", async () => {
      const accounts = await setupToken(TOKEN_PROGRAM_ID, 2_000);

      await takeToken(accounts, requestId(9), 1_000);
      expect(
        await tokenBalance(accounts.feeTakerTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(0);

      await mintTo(
        connection,
        payer,
        accounts.mint,
        accounts.feeTakerTokenAccount,
        payer,
        4_000,
        [],
        { commitment: "confirmed" }
      );
      await takeToken(accounts, requestId(10), 2_000);

      expect(await tokenBalance(accounts.feeTokenAccount, TOKEN_PROGRAM_ID)).eq(
        3_000
      );
      expect(
        await tokenBalance(accounts.recipientTokenAccount, TOKEN_PROGRAM_ID)
      ).eq(3_000);
    });

    it("supports token-2022 mints", async () => {
      const accounts = await setupToken(TOKEN_2022_PROGRAM_ID, 1_000_000);

      await takeToken(accounts, requestId(11), 25_000);

      expect(
        await tokenBalance(accounts.feeTokenAccount, TOKEN_2022_PROGRAM_ID)
      ).eq(25_000);
      expect(
        await tokenBalance(
          accounts.recipientTokenAccount,
          TOKEN_2022_PROGRAM_ID
        )
      ).eq(975_000);
    });
  });

  describe("take_native", () => {
    const minRent = () => connection.getMinimumBalanceForRentExemption(0);

    it("forwards the lamports above the rent-exempt minimum and emits the realized amounts", async () => {
      const recipient = Keypair.generate().publicKey;
      const amount = 1e9;
      const feeAmount = 10_000_000;
      const feeRecipientBefore = await connection.getBalance(feeRecipient);

      // Fund the (empty) fee taker PDA with its rent-exempt minimum plus the amount to forward
      await airdrop(feeTaker, (await minRent()) + amount);

      const signature = await takeNative(requestId(12), feeAmount, recipient);

      expect(await connection.getBalance(feeRecipient)).eq(
        feeRecipientBefore + feeAmount
      );
      expect(await connection.getBalance(recipient)).eq(990_000_000);
      expect(await connection.getBalance(feeTaker)).eq(await minRent());

      const event = await getFeeTakenEvent(signature);
      expect(event.id).deep.eq(requestId(12));
      expect(event.mint).eq(null);
      expect(event.amount.toNumber()).eq(amount);
      expect(event.requestedFeeAmount.toNumber()).eq(feeAmount);
      expect(event.feeAmount.toNumber()).eq(feeAmount);
      expect(event.remainderAmount.toNumber()).eq(990_000_000);
      expect(event.feeRecipient.toBase58()).eq(feeRecipient.toBase58());
      expect(event.recipient.toBase58()).eq(recipient.toBase58());
    });

    it("rejects when only the rent-exempt minimum is left", async () => {
      // Previous test left exactly the rent-exempt minimum in the PDA
      expect(await connection.getBalance(feeTaker)).eq(await minRent());

      await expectError(
        takeNative(requestId(13), 100, Keypair.generate().publicKey),
        "InsufficientBalance"
      );
    });

    it("rejects a fee recipient other than the constant", async () => {
      await airdrop(feeTaker, 1e9);

      await expectError(
        takeNative(requestId(14), 100, Keypair.generate().publicKey, {
          feeRecipient: Keypair.generate().publicKey,
        }),
        "ConstraintAddress"
      );

      expect(await connection.getBalance(feeTaker)).eq((await minRent()) + 1e9);
    });

    it("sends everything to the recipient when the fee exceeds the balance", async () => {
      const recipient = Keypair.generate().publicKey;
      const feeRecipientBefore = await connection.getBalance(feeRecipient);

      // 1 SOL is still in the PDA from the previous test
      const signature = await takeNative(requestId(15), 1e9 + 1, recipient);

      expect(await connection.getBalance(feeRecipient)).eq(feeRecipientBefore);
      expect(await connection.getBalance(recipient)).eq(1e9);
      expect(await connection.getBalance(feeTaker)).eq(await minRent());

      const event = await getFeeTakenEvent(signature);
      expect(event.feeAmount.toNumber()).eq(0);
      expect(event.remainderAmount.toNumber()).eq(1e9);
    });

    it("sends everything to the fee recipient when the fee equals the balance", async () => {
      const recipient = Keypair.generate().publicKey;
      const feeRecipientBefore = await connection.getBalance(feeRecipient);

      await airdrop(feeTaker, 1e9);
      await takeNative(requestId(16), 1e9, recipient);

      expect(await connection.getBalance(feeRecipient)).eq(
        feeRecipientBefore + 1e9
      );
      expect(await connection.getBalance(recipient)).eq(0);
      expect(await connection.getBalance(feeTaker)).eq(await minRent());
    });
  });
});
