import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
import { Warmkey } from "../target/types/warmkey";
import { SystemProgram, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,} from '@solana/web3.js';
import { expect } from "chai";
const {TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, transfer, AuthorityType, createSetAuthorityInstruction,} = require("@solana/spl-token");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


describe("--- WARMKEY TEST ---", async () => {
	
	// Configure the client to use the local cluster.
	const provider = anchor.AnchorProvider.env();
	anchor.setProvider(provider);
	const program = anchor.workspace.warmkey as Program<Warmkey>;

	let senderKeypair: anchor.web3.Keypair;
	let merchantAcc: PublicKey;
	let bump: number;
	let mint;
	let walletDepositTokenAccount;
	let wkBeneficiary: PublicKey = new PublicKey("7iVti5RjdNGahnuaMu5U8Zumy79RFaGp5ESvxCc1MBHo");

	before(async () => {
		console.log("program id:", program.programId);
		
		senderKeypair = anchor.web3.Keypair.generate();
		
		// get merchant's pda acc
		[merchantAcc, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('merchant'), senderKeypair.publicKey.toBuffer()],
			program.programId
		);
		console.log("merchant:", merchantAcc);
		
		// fund sol
		await provider.connection.confirmTransaction(
			await provider.connection.requestAirdrop(senderKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL)
		);
		
		// create new mint (original token, 9 decimals)
		mint = await createMint(
			provider.connection,
			provider.wallet.payer,    // fee payer
			provider.wallet.publicKey,// mint authority
			provider.wallet.publicKey,// freeze authority
			9                         // decimals
		);
		console.log("new token mint:", mint.toBase58());
		
		const blockhash = await provider.connection.getLatestBlockhash();
		console.log("blockhash:", blockhash);
		
		// create token account
		walletDepositTokenAccount = await getOrCreateAssociatedTokenAccount(
			provider.connection,	
			provider.wallet.payer,    // payer
			mint,                     // the token mint
			provider.wallet.publicKey // token owner
		);
		console.log("wallet deposit token account:", walletDepositTokenAccount.address.toBase58());
		
		
		
	});

	it("register", async () => {
		
		var beforeBalance = await provider.connection.getBalance(senderKeypair.publicKey);
		var tx = await program.methods
			.register( provider.wallet.publicKey, [walletDepositTokenAccount.address] )
			.accounts({
				signer: senderKeypair.publicKey,
				systemProgram: SystemProgram.programId,
				merchantAcc: merchantAcc
			})
			.signers(senderKeypair)
			.transaction();


		const regTx = await sendAndConfirmTransaction(provider.connection, tx, [senderKeypair], { commitment: "confirmed" });
		console.log('register tx:', regTx);
		
		var afterBalance = await provider.connection.getBalance(senderKeypair.publicKey);
		
		const regTxDetails = await program.provider.connection.getTransaction(regTx, {
			maxSupportedTransactionVersion: 0,
			commitment: "confirmed",
		});
		
		var rentExemption = await program.provider.connection.getMinimumBalanceForRentExemption(381);
		
		console.log("reg fees:");
		console.log("  SOL changes:", (beforeBalance - afterBalance) / LAMPORTS_PER_SOL);
		console.log("  tx fees:", regTxDetails.meta.fee / LAMPORTS_PER_SOL);
		console.log("  rent exemption:", rentExemption / LAMPORTS_PER_SOL);
		
		// validate log
		var logs = regTxDetails?.meta?.logMessages || null;
		if (!logs) {
			throw new Error('register log not found!');
		}
		//console.log("register log:", logs);
		expect(logs.includes(`Program log: merchant's account: ${merchantAcc.toBase58()}`)).to.be.true;

		// validate onchain data
		const viewMerchantAcc = await provider.connection.getAccountInfo(merchantAcc);
		if (viewMerchantAcc === null) {
			throw new Error('merchant account does not exist!');
		}
		console.log('view merchant acc:', viewMerchantAcc);
		expect(viewMerchantAcc.owner.toBase58()).to.equal(program.programId.toBase58(), "merchant account's owner must be deployed program address");

		let decodedData = await program.account.merchantAcc.fetch(merchantAcc);
		console.log("merchant account data:", decodedData);

		expect(decodedData.user.toBase58()).to.equal(senderKeypair.publicKey.toBase58());
	});
	
	it("test deposit", async () => {
		

		// create new deposit account
		const newDepositAccount = anchor.web3.Keypair.generate();
		
		console.log("new deposit account:", newDepositAccount.publicKey.toBase58());
		
		const newDepositTokenAccount = await getOrCreateAssociatedTokenAccount(
			provider.connection,	
			provider.wallet.payer,      // payer
			mint,                       // the token mint
			newDepositAccount.publicKey // token owner
		);
		console.log("new deposit token account:", newDepositTokenAccount.address.toBase58());
		
		// Mint 100 tokens (10^9) to DTA
		const mintAmount = 100 * 10 ** 9;
		await mintTo(
			provider.connection,
			provider.wallet.payer, // fee payer
			mint,
			newDepositTokenAccount.address,
			provider.wallet,                 // mint authority
			mintAmount
		);
		
		// fund money to new deposit account
		await provider.connection.confirmTransaction(
			// fund sol
			await provider.connection.requestAirdrop(newDepositAccount.publicKey, anchor.web3.LAMPORTS_PER_SOL)
		);
		
		var beforeAccount = await getAccount(provider.connection, newDepositTokenAccount.address);
		console.log("before account owner:", beforeAccount.owner.toBase58());
		
		// change account owner to merchant acc (PDA)
		var tx = new Transaction().add(
			createSetAuthorityInstruction(
				newDepositTokenAccount.address, // token account
				newDepositAccount.publicKey, // current auth
				AuthorityType.AccountOwner , // authority type
				merchantAcc, // new auth
				[],
				TOKEN_PROGRAM_ID, // token program
			),
		);
		const setAuthTx = await provider.sendAndConfirm(tx, [newDepositAccount]);
		console.log('set auth tx:', setAuthTx);
		
		var afterAccount = await getAccount(provider.connection, newDepositTokenAccount.address);
		console.log("after account owner:", afterAccount.owner.toBase58());
		expect(afterAccount.owner.toBase58()).to.equal(merchantAcc.toBase58(), "token account's owner now must be merchant acc (PDA)");
		
		// fundout
		var beforeBeneficiary = await getAccount(provider.connection, walletDepositTokenAccount.address);
		
		try {
			
			var beforeBalance = await provider.connection.getBalance( senderKeypair.publicKey);
			var tx = await program.methods
				.dep_fundout()
				.accounts({
					merchantAcc: merchantAcc,
					signer: senderKeypair.publicKey,
					depTokenAcc: newDepositTokenAccount.address,
					beneficiaryAcc: walletDepositTokenAccount.address,
					wkBeneficiary: new PublicKey("7iVti5RjdNGahnuaMu5U8Zumy79RFaGp5ESvxCc1MBHo"),
					mint: mint,
					tokenProgram: TOKEN_PROGRAM_ID, 
					systemProgram: SystemProgram.programId,
				})
				.signers([senderKeypair]) /* anchor test will auto-push connection.wallet as first signer */
				.transaction();
			
				/* 
				- this method also accept array to foster multisig
				- Anchor automatically passes the wallet account in the provider as a signer, so we don’t need to add it to the signers array again.
				- https://solana.stackexchange.com/questions/17919/how-to-use-sendandconfirmtransaction
				*/
			
				//.rpc({ commitment: "confirmed" });
			
			const fundoutTx = await sendAndConfirmTransaction(provider.connection, tx, [senderKeypair], { commitment: "confirmed" });
			
			console.log('fundout tx:', fundoutTx);
			
			var afterBalance = await provider.connection.getBalance( senderKeypair.publicKey);
			
			const fundoutTxDetails = await program.provider.connection.getTransaction(fundoutTx, {
				maxSupportedTransactionVersion: 0,
				commitment: "confirmed",
			});
			var logs = fundoutTxDetails?.meta?.logMessages || null;
			if (!logs) {
				throw new Error('fundout log not found!');
			}
			//console.log("fundout log:", logs);
			console.log("fundout tx fee:", 
				(beforeBalance - afterBalance) / LAMPORTS_PER_SOL, "(SOL)", 
				fundoutTxDetails.meta.fee / LAMPORTS_PER_SOL, "(SOL)", 
				fundoutTxDetails.meta.computeUnitsConsumed, "(CU)"
			);
		} catch (_err) {
			console.log("_err:", _err.message);
			expect(_err instanceof AnchorError).to.be.true;
			expect(_err.error.errorMessage, "invalid mint");
			return;
		}

		var afterBeneficiary = await getAccount(provider.connection, walletDepositTokenAccount.address);
		expect(afterBeneficiary.amount - beforeBeneficiary.amount).to.equal(100n * BigInt(anchor.web3.LAMPORTS_PER_SOL), "fundout amount incorrect");
	});
});
