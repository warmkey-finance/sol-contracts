import * as anchor from "@coral-xyz/anchor";
import { BN, BorshCoder,Program, AnchorError, EventParser } from "@coral-xyz/anchor";
import { Warmkey } from "../target/types/warmkey";
import { Keypair, SystemProgram, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY ,} from '@solana/web3.js';
import { expect } from "chai";
const {ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, mintTo, getAccount, transfer, AuthorityType, createSetAuthorityInstruction, createAssociatedTokenAccountInstruction,createApproveInstruction, } = require("@solana/spl-token");
import { Emit } from "../target/types/emit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const getTxSize = (tx: Transaction, feePayer: PublicKey): number => {
	const LOW_VALUE = 127; // 0x7f
	const HIGH_VALUE = 16383; // 0x3fff
	const compactHeader = (n: number) => (n <= LOW_VALUE ? 1 : n <= HIGH_VALUE ? 2 : 3);
	const compactArraySize = (n: number, size: number) => compactHeader(n) + n * size;
	
	const feePayerPk = [feePayer.toBase58()];

	const signers = new Set<string>(feePayerPk);
	const accounts = new Set<string>(feePayerPk);

	const ixsSize = tx.instructions.reduce((acc, ix) => {
		ix.keys.forEach(({ pubkey, isSigner }) => {
			const pk = pubkey.toBase58();
			if (isSigner) signers.add(pk);
			accounts.add(pk);
		});

		accounts.add(ix.programId.toBase58());

		const nIndexes = ix.keys.length;
		const opaqueData = ix.data.length;

		return (
			acc +
			1 + // PID index
			compactArraySize(nIndexes, 1) +
			compactArraySize(opaqueData, 1)
		);
	}, 0);

	return (
		compactArraySize(signers.size, 64) + // signatures
		3 + // header
		compactArraySize(accounts.size, 32) + // accounts
		32 + // blockhash
		compactHeader(tx.instructions.length) + // instructions
		ixsSize
	);
}

describe("--- WARMKEY CORE ---", async () => {
	
	// Configure the client to use the local cluster.
	const provider = anchor.AnchorProvider.env();
	anchor.setProvider(provider);
	const program = anchor.workspace.warmkey as Program<Warmkey>;

	let merchantWallet: anchor.web3.Keypair = anchor.web3.Keypair.generate();
	let merchantTokenAccount;
	let merchantData: PublicKey;
	
	let bump: number;
	
	let mint;
	
	let wkBeneficiary = new PublicKey("5W9kUdZMPk5gR6XiRVyri2cps1kJRY3b8eb6b76qYiEX");
	let wkBeneficiaryTokenAcc;
	
	
	//let referral = wkBeneficiary;
	let referral: anchor.web3.Keypair = anchor.web3.Keypair.generate();
	let refTokenAccount;
	
	let programAcc: PublicKey;
	
	before(async () => {
		
		console.log("provider wallet:", provider.wallet.publicKey.toBase58());
		/*
		// check account info
		const accountInfo = await provider.connection.getAccountInfo(provider.wallet.publicKey);
		console.log(JSON.stringify(accountInfo, null, 2));
		return;
		*/
		
		console.log("program id:", program.programId.toBase58());
		
		// create new mint (original token, 9 decimals)
		mint = await createMint(
			provider.connection,
			provider.wallet.payer,    // fee payer
			provider.wallet.publicKey,// mint authority
			provider.wallet.publicKey,// freeze authority
			9                         // decimals
		);
		console.log("new token mint:", mint.toBase58());
		
		const block = await provider.connection.getLatestBlockhash();
		console.log("blockhash:", block.blockhash, "height:", block.lastValidBlockHeight);
		
		//create wk beneficiary token acc
		wkBeneficiaryTokenAcc = await getOrCreateAssociatedTokenAccount(
			provider.connection,	
			provider.wallet.payer,   // payer
			mint,                    // the token mint
			wkBeneficiary // token owner
		);
		console.log("provider token account (wk beneficiary):", wkBeneficiaryTokenAcc.address.toBase58());
		
		//===== process referral =====
		if (wkBeneficiary.toBase58() != referral.publicKey.toBase58()) {
			// create referral token account
			refTokenAccount = await getOrCreateAssociatedTokenAccount(
				provider.connection,	
				provider.wallet.payer,   // payer
				mint,                    // the token mint
				referral.publicKey // token owner
			);
			console.log("referral token account:", refTokenAccount.address.toBase58());
		} else {
			refTokenAccount = wkBeneficiaryTokenAcc;
		}
		
		
		//===== process merchant =====
		
		// fund sol to merchant wallet
		await provider.connection.confirmTransaction(
			await provider.connection.requestAirdrop(merchantWallet.publicKey, anchor.web3.LAMPORTS_PER_SOL * 1000)
		);
		
		console.log("merchant wallet:", merchantWallet.publicKey.toBase58());
		
		// create merchant token account
		merchantTokenAccount = await getOrCreateAssociatedTokenAccount(
			provider.connection,	
			provider.wallet.payer,   // payer
			mint,                    // the token mint
			merchantWallet.publicKey // token owner
		);
		console.log("merchant token account:", merchantTokenAccount.address.toBase58());
		
		// get merchant pda
		[merchantData, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('merchant'), merchantWallet.publicKey.toBuffer()],
			program.programId
		);
		console.log("merchant pda:", merchantData.toBase58());
		
		//===== setup program =====
		[programAcc, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('programstate'), provider.wallet.payer.publicKey.toBuffer()],
			program.programId
		);
		console.log("program stater:", programAcc.toBase58());
		var tx = await program.methods
			.initProgram( wkBeneficiary )
			.accounts({
				programState: programAcc,
				signer: provider.wallet.payer.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
		const initProgTx = await sendAndConfirmTransaction(provider.connection, tx, [provider.wallet.payer], { commitment: "confirmed" });
		console.log('init program tx:', initProgTx);
		console.log("tx size:", getTxSize(tx, provider.wallet.payer.publicKey));
		
	});
	
	it("register", async () => {
		
		var beforeBalance = await provider.connection.getBalance(merchantWallet.publicKey);
		var tx = await program.methods
			.register( referral.publicKey, [merchantWallet.publicKey] )
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		
		const regTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log('register tx:', regTx);
		var afterBalance = await provider.connection.getBalance(merchantWallet.publicKey);
		const regTxDetails = await program.provider.connection.getTransaction(regTx, {maxSupportedTransactionVersion: 0, commitment: "confirmed"});

		var balance = await provider.connection.getBalance(merchantData);
		
		const getMerchantDataAcc = await provider.connection.getAccountInfo(merchantData);
		console.log("merchant acc length:", getMerchantDataAcc.data.length);
		var rentExemption = await program.provider.connection.getMinimumBalanceForRentExemption(getMerchantDataAcc.data.length);
		
		console.log("reg fees:");
		console.log("  SOL changes:", (beforeBalance - afterBalance) / LAMPORTS_PER_SOL);
		console.log("  tx fees:", regTxDetails.meta.fee / LAMPORTS_PER_SOL);
		console.log("  rent exemption:", rentExemption / LAMPORTS_PER_SOL);
		console.log("  merchant acc:", balance / LAMPORTS_PER_SOL);
		
		// validate merchant pda's owner
		if (getMerchantDataAcc === null) {
			throw new Error('merchant account does not exist!');
		}
		expect(getMerchantDataAcc.owner.toBase58()).to.equal(program.programId.toBase58(), "merchant account's owner must be deployed program address");
		
		// validate log
		var logs = regTxDetails?.meta?.logMessages || null;
		if (!logs) {
			throw new Error('register log not found!');
		}
		//console.log("register log:", logs);
		
		const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
		const events = eventParser.parseLogs(logs);
		for (let event of events) {
			//console.log(event);
		}
		
		let merchantDataAcc = await program.account.merchantData.fetch(merchantData);
		expect(merchantDataAcc.authority.toBase58()).to.equal(merchantWallet.publicKey.toBase58());
		
	});
	
	it("fundout", async () => {
		return;
		let depositWallets = [anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate()];
		let depositTokenAccounts = [];
		
		//batch transfer to $depositWallets
		var accountMetas = [];
		var amounts = [];
		for(var x in depositWallets) {
			var depositWallet = depositWallets[x];
			accountMetas.push({pubkey: depositWallet.publicKey, isWritable: true, isSigner: false});
			amounts.push(new BN(anchor.web3.LAMPORTS_PER_SOL));
		}
		// 2 persons: 64767 CU, 3 persons: 82675 CU, 4 persons: 106583 CU, 5 persons: 130491 CU
		var tx = await program.methods
			.depSupplyApprovalGas( new BN(123), amounts )
			.remainingAccounts(accountMetas)
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const supplyGasTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log('supply gas tx:', supplyGasTx);
		console.log("tx size:", getTxSize(tx, merchantWallet.publicKey));
		const supplyGasTxDetails = await program.provider.connection.getTransaction(supplyGasTx, {
			maxSupportedTransactionVersion: 0,
			commitment: "confirmed",
		});
		console.log(supplyGasTxDetails);
		
		for(var x in depositWallets) {
			let depositWallet = depositWallets[x];
			// fund sol to deposit wallet
			await provider.connection.confirmTransaction(
				await provider.connection.requestAirdrop(depositWallet.publicKey, anchor.web3.LAMPORTS_PER_SOL)
			);
			
			console.log("deposit wallet:", depositWallet.publicKey.toBase58());

			// create deposit token account
			let created = await getOrCreateAssociatedTokenAccount(
				provider.connection,	
				provider.wallet.payer,  // payer
				mint,                   // the token mint
				depositWallet.publicKey // token owner
			);
			
			depositTokenAccounts.push(created);
			var depositTokenAccount = depositTokenAccounts[depositTokenAccounts.length - 1];
			
			console.log("deposit token account:", depositTokenAccount.address.toBase58());
			
			// Mint 100 tokens (10^9) to DTA
			const mintAmount = 100 * 10 ** 9;
			await mintTo(
				provider.connection,
				provider.wallet.payer, // fee payer
				mint,
				depositTokenAccount.address,
				provider.wallet, // mint authority
				mintAmount
			);
			
			var beforeDepTokenAcc = await getAccount(provider.connection, depositTokenAccount.address);
			
			// change account owner to merchant pda
			var tx = new Transaction().add(
				createSetAuthorityInstruction(
					depositTokenAccount.address, // token account
					depositWallet.publicKey,     // current auth
					AuthorityType.AccountOwner,  // authority type
					merchantData,                 // new auth
					[],
					TOKEN_PROGRAM_ID,            // token program
				),
			);
			const setAuthTx = await provider.sendAndConfirm(tx, [depositWallet]);
			console.log('set auth tx:', setAuthTx);
		
			var afterDepTokenAcc = await getAccount(provider.connection, depositTokenAccount.address);
			expect(afterDepTokenAcc.owner.toBase58()).to.equal(merchantData.toBase58(), "token account's owner now must be merchant acc (PDA)");
		}
		
		// fundout
		var getMerchantData = await program.account.merchantData.fetch(merchantData);
		var beforeWkBeneficiary = await getAccount(provider.connection, wkBeneficiaryTokenAcc.address);
		var beforeRef = await getAccount(provider.connection, refTokenAccount.address);
		
		var accountMetas = [];
		for(var x in depositTokenAccounts) {
			var depositTokenAccount = depositTokenAccounts[x];
			accountMetas.push({pubkey: depositTokenAccount.address, isWritable: true, isSigner: false});
		}
		//1 deposit account = 45354 CU, 2 deposit account = 61764
		//1 deposit account = 23968 CU, 2 deposit account = 39094

		var tx = await program.methods
			.depFundout( 0/*merchant beneficiary index*/ )
			.remainingAccounts(accountMetas)
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				referral: refTokenAccount.address,
				beneficiaryAcc: merchantTokenAccount.address,
				wkBeneficiary: wkBeneficiaryTokenAcc.address,
				tokenProgram: TOKEN_PROGRAM_ID, 
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const fundoutTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log('fundout tx:', fundoutTx);
		console.log("tx size:", getTxSize(tx, merchantWallet.publicKey));
		const fundoutTxDetails = await program.provider.connection.getTransaction(fundoutTx, {
			maxSupportedTransactionVersion: 0,
			commitment: "confirmed",
		});
		console.log(fundoutTxDetails);
		
		/*
		var afterDepTokenAcc = await getAccount(provider.connection, depositTokenAccount.address);
		expect(Number(afterDepTokenAcc.amount)).to.equal(0);
		
		var afterRef = await getAccount(provider.connection, refTokenAccount.address);
		var refEarn = (Number(afterRef.amount) - Number(beforeRef.amount)) / LAMPORTS_PER_SOL;
		if (getMerchantData.referral.toBase58() == wkBeneficiary.toBase58()) {
			expect(refEarn).to.equal(0);
		} else {
			expect(refEarn).to.equal((mintAmount/LAMPORTS_PER_SOL) * 0.25 / 100);
		}
		
		var afterWkBeneficiary = await getAccount(provider.connection, wkBeneficiaryTokenAcc.address);
		var wkBeneficiaryEarn = (Number(afterWkBeneficiary.amount) - Number(beforeWkBeneficiary.amount)) / LAMPORTS_PER_SOL;
		if (getMerchantData.referral.toBase58() == wkBeneficiary.toBase58()) {
			expect(wkBeneficiaryEarn).to.equal((mintAmount/LAMPORTS_PER_SOL) * 0.5 / 100);
		} else {
			expect(wkBeneficiaryEarn).to.equal((mintAmount/LAMPORTS_PER_SOL) * 0.25 / 100);
		}
		*/
	});
	
	
	it("withdrawal", async () => {
		
		//enable withdrawal
		let wdWallet: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let wdTokenAccount;
		let wdAgent;
		let wdDataPda;
		
		[wdAgent, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('wdagent'), wdWallet.publicKey.toBuffer()],
			program.programId
		);
		console.log("wd agent:", wdAgent.toBase58());
		
		[wdDataPda, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('wddata'), wdWallet.publicKey.toBuffer(), mint.toBuffer()],
			program.programId
		);
		console.log("wd data acc:", wdDataPda.toBase58());
		
		var tx = await program.methods
			.wdEnable()
			.accounts({
				signer: merchantWallet.publicKey,
				wkSigner: provider.wallet.publicKey,
				wdExecutor: wdWallet.publicKey,
				merchantData: merchantData,
				wdAgent: wdAgent,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const wdEnableTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet, provider.wallet.payer, wdWallet], { commitment: "confirmed" });
		//var thisAcc = await provider.connection.getAccountInfo(wdAgent);
		//console.log("wd executor pda:", thisAcc);
		console.log('wd enable tx:', wdEnableTx);
		
		// supply gas to wdWallet
		var tx = await program.methods
			.wdSupplyExecutorGas( new BN(anchor.web3.LAMPORTS_PER_SOL) )
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				wdExecutor: wdWallet.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const supplyGasTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log("supply gas tx:", supplyGasTx);
		
		// create wd token account 
		wdTokenAccount = await getOrCreateAssociatedTokenAccount(
			provider.connection,	
			provider.wallet.payer, // payer
			mint,                  // the token mint
			wdWallet.publicKey,     // token owner,
		);
		
		// change account owner to wd agent
		var tx = new Transaction().add(
			createSetAuthorityInstruction(
				wdTokenAccount.address, // token account
				wdWallet.publicKey,     // current auth
				AuthorityType.AccountOwner,  // authority type
				wdAgent,                 // new auth
				[],
				TOKEN_PROGRAM_ID,            // token program
			),
		);
		const setAuthTx = await provider.sendAndConfirm(tx, [wdWallet]);
		console.log("set auth tx:", setAuthTx);
		
		//===== SUPPLY ROLLING =====
		
		// delegate max amount from merchantTokenAccount to merchantPda
		var tx = new Transaction().add(
			createApproveInstruction(
				merchantTokenAccount.address,// token account
				merchantData,                // authorizer
				merchantWallet.publicKey,    // owner
				100 * 10 ** 9,        //delegated amount, change to max 18446744073709551615
			),
		);
		const setApprovalTx = await provider.sendAndConfirm(tx, [merchantWallet]);
		console.log("set approval tx:", setApprovalTx);
		
		// fund 100 tokens to merchantTokenAccount
		const mintAmount = 100 * 10 ** 9;
		await mintTo(
			provider.connection,
			provider.wallet.payer,        // fee payer
			mint,
			merchantTokenAccount.address, //to
			provider.wallet,              // mint authority
			mintAmount
		);
		
		//var merchantTokenAcc = await getAccount(provider.connection, merchantTokenAccount.address);
		//console.log("merchant token acc:", merchantTokenAcc);
		
		// supply rolling
		var tx = await program.methods
			.wdSupplyRolling( new BN(mintAmount) )
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				merchantToken: merchantTokenAccount.address,
				wdToken: wdTokenAccount.address,
				tokenProgram: TOKEN_PROGRAM_ID,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const wdSupplyRollingTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log("supply rolling tx:", wdSupplyRollingTx);
		
		//===== PAYOUT =====
		
		// payout to 2 recipients
		let recipient1: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let recipient2: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		
		var requests = [
			[ mint, recipient1, new BN(50), new BN(1), new BN(43) ],
			[ mint, recipient2, new BN(75), new BN(2), new BN(44) ],
		];

		var tx = new Transaction();
		var accountMetas = [];
		var createAtaIdxs = [];
		var amounts = [];
		var ourIds = [];
		var theirIds = [];
		for(var x in requests) {
			var request = requests[x];
			var _mint = request[0]; 
			var _recipient = request[1];
			var _amount = request[2]; amounts.push( _amount );
			var _our_id = request[3]; ourIds.push( _our_id );
			var _their_id = request[4]; theirIds.push( _their_id );

			//test with create ATA
			var recipientTokenAcc = await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, _mint, _recipient.publicKey);
			recipientTokenAcc = recipientTokenAcc.address;

			//var recipientTokenAcc = await getAssociatedTokenAddress(_mint, _recipient.publicKey);
			var thisAcc = await provider.connection.getAccountInfo(recipientTokenAcc);
			if (thisAcc === null) {
				/*
				tx.add(
					createAssociatedTokenAccountInstruction(
						wdWallet.publicKey,   // payer
						recipientTokenAcc,    // ATA
						_recipient.publicKey, // owner
						mint,                 // mint
						TOKEN_PROGRAM_ID,     // program id
						ASSOCIATED_TOKEN_PROGRAM_ID
					)
				);
				*/

				accountMetas.push({pubkey: recipientTokenAcc, isWritable: true, isSigner: false});
				createAtaIdxs.push(new BN(accountMetas.length - 1));
				accountMetas.push({pubkey: _recipient.publicKey, isWritable: false, isSigner: false});

			} else {
				accountMetas.push({pubkey: recipientTokenAcc, isWritable: true, isSigner: false});
			}
		}

		// Vec<u64} type need not to be process by Buffer.from, lol??
		var payoutInstr = await program.methods
				.wdPayout(amounts, ourIds, theirIds, Buffer.from(createAtaIdxs))
				.remainingAccounts(accountMetas)
				.accounts({
					wdAgent: wdAgent,
					wdData: wdDataPda,
					signer: wdWallet.publicKey,
					funder: wdTokenAccount.address,
					tokenProgram: TOKEN_PROGRAM_ID,
					systemProgram: SystemProgram.programId,
					mint: mint,
					associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
					rent: SYSVAR_RENT_PUBKEY,
				})
				.transaction();
		tx.add(payoutInstr);

		const payoutTx = await provider.sendAndConfirm(tx, [wdWallet],{ commitment: "confirmed" });
		const payoutTxDetails = await program.provider.connection.getTransaction(payoutTx, {
			maxSupportedTransactionVersion: 0,
			commitment: "confirmed",
		});
		
		console.log("");
		console.log('payout tx:', payoutTx);
		console.log("tx size:", getTxSize(tx, wdWallet.publicKey));
		console.log(payoutTxDetails);
		
		//check recipient receive amount
		for(var x in requests) {
			var request = requests[x];
			var _mint = request[0];
			var _recipient = request[1];
			var _amount = request[2];
			
			
			var recipientTokenAddr = await getAssociatedTokenAddress(_mint, _recipient.publicKey);
			var recipientTokenAcc = await getAccount(provider.connection, recipientTokenAddr);
			
			console.log(recipientTokenAcc.amount);
			
		}
	});
	
});