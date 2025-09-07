use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, Transfer};
use anchor_spl::associated_token::{self,AssociatedToken, get_associated_token_address_with_program_id, Create};
use anchor_lang::system_program;
use std::mem::size_of;
#[allow(unused_imports)]
use solana_security_txt::security_txt;

declare_id!("warmPv4soGeXuRHdiUj6hiFRhaxFsP2h1B2aF6Gd3KF");

// program
const VERSION: &str = "2.0.2";

// space allocation
const ACC_DISCRI_LEN: usize = 8;
const ADDRESS_LEN: usize = 32;

// settings
const FEES: u64 =  50; // 0.5%, /10000 to get multiply
const SHARE_REVENUE: u64 = 5000; //50%
const OWNER:Pubkey = pubkey!("EjC3ciptXau6mYyS1RcsyJpDshREhVKPdVAmawLLNsZU");
const WK_SIGNER:Pubkey = pubkey!("hwwKYKJ57UASjFDhCp3jtGwmJV2DBEGPjRodvHd2ZJq");
const WK_BENEFICIARY:Pubkey = pubkey!("5W9kUdZMPk5gR6XiRVyri2cps1kJRY3b8eb6b76qYiEX");

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "warmkey",
    project_url: "https://www.warmkey.finance",
    contacts: "email:business@warmkey.finance, twitter:@warmkeyfinance",
    policy: "https://github.com/warmkey-finance/sol-contracts/blob/master/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/warmkey-finance/sol-contracts"
}

#[program]
pub mod warmkey {
    use super::*;
	
	//===== CORE =====
    pub fn register(ctx: Context<Register>, referral: Pubkey, beneficiaries: Vec<Pubkey>) -> Result<()> {

		let merchant_data = &mut ctx.accounts.merchant_data;
		merchant_data.authority = ctx.accounts.signer.key();
		merchant_data.bump = ctx.bumps.merchant_data;
		merchant_data.referral = referral;
		merchant_data.beneficiaries = beneficiaries;
		
		emit!(RegisterEvent { 
			merchant_executor: merchant_data.authority, 
			referral: referral,
			beneficiaries: merchant_data.beneficiaries.clone(),
			merchant_data: merchant_data.key(),
		});
		
        Ok(())
    }

	pub fn dep_update_beneficiary(ctx: Context<DepUpdateBeneficiary>, beneficiaries: Vec<Pubkey>) -> Result<()> {
		
		require!(WK_SIGNER == ctx.accounts.wk_signer.key(), Error::InvalidWkSigner);
		
		let merchant_data = &mut ctx.accounts.merchant_data;
		let signer = &ctx.accounts.signer;		

		require!(merchant_data.authority.key() == signer.key(), Error::OnlyMerchant);
		
		merchant_data.beneficiaries = beneficiaries;
		
		emit!(DepUpdateBeneficiaryEvent { 
			merchant_executor: signer.key(), 
		});
		
		Ok(())
	}
	
	pub fn dep_supply_approval_gas<'a, 'b, 'c, 'info>(
		ctx: Context<'a, 'b, 'c, 'info, DepSupplyApprovalGas<'info>>,
		batch_id: u64,
		amounts: Vec<u64>,
	) -> Result<()> {
		
		let signer = &ctx.accounts.signer;
		
		require!(amounts.len() == ctx.remaining_accounts.len(),Error::MismatchedRecipientAmounts);
		
		//only registered merchant can use
		let merchant_data = &mut ctx.accounts.merchant_data;
		require!(merchant_data.authority.key() == signer.key(), Error::OnlyMerchant);
		
		let system_program = &ctx.accounts.system_program;
		
		let mut supply_gas:u128 = 0;
		for (recipient, &amount) in ctx.remaining_accounts.iter().zip(amounts.iter()) {
			let cpi_accounts = system_program::Transfer {
				from: signer.to_account_info(),
				to: recipient.to_account_info(),
			};
			let cpi_program = system_program.to_account_info();
			let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
			system_program::transfer(cpi_context, amount)?;
			
			supply_gas += amount as u128;
		}
		
		emit!(DepSupplyApprovalGasEvent { 
			merchant_executor: signer.key(), 
			batch_id: batch_id,
			supply_gas: supply_gas,
		});
		 
		Ok(())
	}

	pub fn dep_fundout_sol<'a, 'b, 'c, 'info>(
		ctx: Context<'a, 'b, 'c, 'info, DepFundoutSol<'info>>, 
		beneficiary_idx:u8
	) -> Result<()> {
		
		let system_program = &ctx.accounts.system_program;
		let merchant_data = &ctx.accounts.merchant_data;
		let beneficiary_acc = &ctx.accounts.beneficiary_acc;
		let referral = &ctx.accounts.referral;
		let wk_beneficiary = &ctx.accounts.wk_beneficiary;
		require!(merchant_data.beneficiaries.len() as u8 > beneficiary_idx, Error::InvalidBeneficiary);
		require!(ctx.remaining_accounts.len() > 0, Error::NoDepositAccount);
		require!(merchant_data.beneficiaries[beneficiary_idx as usize].key() == beneficiary_acc.key(), Error::InvalidBeneficiary);
		require!(merchant_data.referral.key() == referral.key(), Error::InvalidReferral);
		
		let signer = &ctx.accounts.signer;
		let authority = merchant_data.authority.key();
		require!(authority == signer.key(), Error::OnlyMerchant);

		let mut amounts:u64 = 0;
		for dep_acc in ctx.remaining_accounts {
			let balance = dep_acc.to_account_info().lamports();
			
			//park at merchant data acc first only split
			let cpi_accounts = system_program::Transfer {
				from: dep_acc.to_account_info(),
				to: merchant_data.to_account_info(),
			};
			let cpi_program = system_program.to_account_info();
			let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
			system_program::transfer(cpi_context, balance)?;
			
			amounts += balance;
		}
		
		if amounts > 0 {

			merchant_data.sub_lamports(amounts)?;

			let mut to_wk_amt = (amounts * FEES) / 10000;
			let mut to_ref_amt = 0;

			if referral.key() != wk_beneficiary.key() {
				to_ref_amt = (to_wk_amt * SHARE_REVENUE) / 10000;
				
				let res = referral.add_lamports(to_ref_amt);
				if res.is_ok() {
					to_wk_amt -= to_ref_amt; 
				} else {
					to_ref_amt = 0; //nothing happen
				}
			}

			let to_merchant_amt = amounts - to_wk_amt - to_ref_amt;

			wk_beneficiary.add_lamports(to_wk_amt)?;
			beneficiary_acc.add_lamports(to_merchant_amt)?;

		}
		
		emit!(DepFundoutEvent { 
			merchant_executor: authority, 
			mint: pubkey!("1nc1nerator11111111111111111111111111111111"),
			fundout: amounts as u128,
		});
		
		
		Ok(())
	}

	pub fn dep_fundout<'a, 'b, 'c, 'info>(
		ctx: Context<'a, 'b, 'c, 'info, DepFundout<'info>>, 
		beneficiary_idx:u8
	) -> Result<()> {
		
		let merchant_data = &ctx.accounts.merchant_data;
		require!(merchant_data.beneficiaries.len() as u8 > beneficiary_idx, Error::InvalidBeneficiary);
		require!(ctx.remaining_accounts.len() > 0, Error::NoDepositAccount);
		
		let signer = &ctx.accounts.signer;
		let authority = merchant_data.authority.key();
		require!(authority == signer.key(), Error::OnlyMerchant);
		
        let token_program = &ctx.accounts.token_program;
		let token_program_key = token_program.key();
		let beneficiary = &ctx.accounts.beneficiary_acc;
		let bump = merchant_data.bump;
		let wk_beneficiary = &ctx.accounts.wk_beneficiary;
		let referral = &ctx.accounts.referral; // ata
		let signer_seeds: &[&[&[u8]]] = &[&[b"merchant", authority.as_ref(), &[bump]]];
		
		let mut amounts:u128 = 0;
		let mut checked:bool = false;
		let mut has_valid_ref = referral.key() != wk_beneficiary.key(); //token acc
		let mut mint:Pubkey = pubkey!("1nc1nerator11111111111111111111111111111111");

		for dep_token_acc in ctx.remaining_accounts {
			
			let mut cpi_accounts;
			let mut cpi_ctx;
			let _dep_token_data = dep_token_acc.try_borrow_data()?;
			let mut slice_ref: &[u8] = &_dep_token_data;
            let dep_token_data = TokenAccount::try_deserialize(&mut slice_ref)?;
			drop(_dep_token_data);
			let mint_addr = dep_token_data.mint.key();
			
			if !checked {
				// check once only
				mint = dep_token_data.mint.key();
				require!(mint_addr == mint.key(), Error::InvalidMint);
				
				let wk_ata = get_associated_token_address_with_program_id(&WK_BENEFICIARY, &mint_addr, &token_program_key);	
				require!(wk_ata.key() == wk_beneficiary.key(), Error::InvalidWkBeneficiary);
				
				let beneficiary_ata = get_associated_token_address_with_program_id(&merchant_data.beneficiaries[beneficiary_idx as usize].key(), &mint_addr,&token_program_key);	
				require!(beneficiary_ata.key() == beneficiary.key(), Error::InvalidBeneficiary);
				
				// check referral ata
				let ref_ata = get_associated_token_address_with_program_id(&merchant_data.referral.key(), &mint_addr, &token_program_key);	
				
				if ref_ata.key() != referral.key() {
					has_valid_ref = false;
				} 
				checked = true;
			} else {
				require!(mint_addr == mint.key(), Error::InvalidMint);
			}
			
			let amount = dep_token_data.amount;
			let mut to_wk_amt = (amount * FEES) / 10000;
			let mut to_ref_amt = 0;
			amounts += amount as u128;
			
			if has_valid_ref {
				to_ref_amt = (to_wk_amt * SHARE_REVENUE) / 10000;
				
				if to_ref_amt > 0 {
					// transfer to ref
					cpi_accounts = Transfer {
						from: dep_token_acc.to_account_info(),
						to: referral.to_account_info(), 
						authority: merchant_data.to_account_info(),
					};
					
					cpi_ctx = CpiContext::new(token_program.to_account_info(), cpi_accounts).with_signer(signer_seeds);
					
					let res = token_interface::transfer(cpi_ctx, to_ref_amt); 
					if res.is_ok() {
						to_wk_amt -= to_ref_amt; 
					} else {
						to_ref_amt = 0; //nothing happen
						has_valid_ref = false;
					}
				}
			}
			let to_merchant_amt = amount - to_wk_amt - to_ref_amt;
			
			// transfer to wk		
			cpi_accounts = Transfer {
				from: dep_token_acc.to_account_info(),
				to: wk_beneficiary.to_account_info(), 
				authority: merchant_data.to_account_info(),
			};
			
			cpi_ctx = CpiContext::new(token_program.to_account_info(), cpi_accounts).with_signer(signer_seeds);
			token_interface::transfer(cpi_ctx, to_wk_amt)?;	
			
			// transfer to merchant
			cpi_accounts = Transfer {
				from: dep_token_acc.to_account_info(),
				to: beneficiary.to_account_info(), 
				authority: merchant_data.to_account_info(),
			};
			
			cpi_ctx = CpiContext::new(token_program.to_account_info(), cpi_accounts).with_signer(signer_seeds);
			token_interface::transfer(cpi_ctx, to_merchant_amt)?;
		}
		
		emit!(DepFundoutEvent { 
			merchant_executor: authority, 
			mint: mint.key(),
			fundout: amounts,
		});
		
		Ok(())
	}
	
	pub fn wd_enable(ctx: Context<WdEnable>) -> Result<()> {
		
		require!(WK_SIGNER == ctx.accounts.wk_signer.key(), Error::InvalidWkSigner);
		
		let merchant_data = &mut ctx.accounts.merchant_data;
		let signer = &ctx.accounts.signer;
		let wd_executor = &ctx.accounts.wd_executor;

		require!(merchant_data.authority.key() == signer.key(), Error::OnlyMerchant);
		
		let wd_agent = &mut ctx.accounts.wd_agent;
		wd_agent.authority = wd_executor.key();
		wd_agent.merchant = signer.key();
		wd_agent.bump = ctx.bumps.wd_agent;
		
		merchant_data.wd_executor = wd_agent.authority;
		
		emit!(WdEnableEvent { 
			merchant_executor: signer.key(), 
			wd_executor: wd_agent.authority,
		});
		
		Ok(())
	}
	
	pub fn wd_supply_executor_gas(ctx: Context<WdSupplyExecutorGas>, amount: u64) -> Result<()> {
		
		let merchant_data = &mut ctx.accounts.merchant_data;
		let signer = &ctx.accounts.signer;
		require!(merchant_data.authority.key() == signer.key(), Error::OnlyMerchant);
		
		let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(), 

            system_program::Transfer {
                from: ctx.accounts.signer.to_account_info(),
                to: ctx.accounts.wd_executor.to_account_info(),
            }
        );	

        let _ = system_program::transfer(cpi_context, amount);
		
		emit!(WdSupplyExecutorGasEvent{
			merchant_executor: ctx.accounts.signer.key(),
			supply_gas: amount,
		});
		
		Ok(())
	}
	
	pub fn wd_supply_rolling(ctx: Context<WdSupplyRolling>, amount: u64) -> Result<()> {
		
		let merchant_data = &ctx.accounts.merchant_data;
		let signer = &ctx.accounts.signer;
		require!(merchant_data.authority.key() == signer.key(), Error::OnlyMerchant);

		let wd_token = &ctx.accounts.wd_token;
		let token_program = &ctx.accounts.token_program;
		let merchant_token = &ctx.accounts.merchant_token;
		let merchant_wallet = &ctx.accounts.signer.key();
		let bump = merchant_data.bump;
		
		//===== transfer =====
		let signer_seeds: &[&[&[u8]]] = &[&[b"merchant", merchant_wallet.as_ref(), &[bump]]];
		
		// transfer to wd token
		let cpi_accounts = Transfer {
			from: merchant_token.to_account_info(),
			to: wd_token.to_account_info(), 
			authority: merchant_data.to_account_info(),
		};
		
        let cpi_ctx = CpiContext::new(token_program.to_account_info(), cpi_accounts).with_signer(signer_seeds);
		token_interface::transfer(cpi_ctx, amount)?;

		emit!(WdSupplyRollingEvent{
			merchant_executor: signer.key(),
			merchant_token: merchant_token.key(), // here can know what mint it is
			amount: amount,
		});
		
		Ok(())
	}
	
	// wdPayout
	pub fn wd_payout<'a, 'b, 'c, 'info>(
		ctx: Context<'a, 'b, 'c, 'info, WdPayout<'info>>, 
		amounts: Vec<u64>, 
		wd_ids: Vec<u64>, 
		their_wd_ids: Vec<u64>,
		create_ata_idxs: Vec<u8>,
	) -> Result<()> {
		
		let wd_agent = &mut ctx.accounts.wd_agent;
		let authority = wd_agent.authority.key();
		let bump = wd_agent.bump;
		let token_program = &ctx.accounts.token_program;
		let associated_token_program = &ctx.accounts.associated_token_program;
		let mint = &ctx.accounts.mint;
		let system_program = &ctx.accounts.system_program;
		let signer = &ctx.accounts.signer;
		let wd_data = &mut ctx.accounts.wd_data;
		wd_data.bump = ctx.bumps.wd_data;
		wd_data.authority = authority;
		let is_main = wd_data.main_from_wd_id > 0 && wd_data.main_to_wd_id > 0;

		require!(authority == signer.key(), Error::OnlyWdExecutor);

		let remainings = &ctx.remaining_accounts;
		let mut i_acc:u8 = 0;
		let mut i_req:usize = 0;
		let mut last_wd_id = if is_main { wd_data.main_from_wd_id - 1} else { wd_data.last_wd_id  } ;
		let remainings_len:u8 = remainings.len() as u8;
		let signer_seeds: &[&[&[u8]]] = &[&[b"wdagent", authority.as_ref(), &[bump]]];

		loop {

			let recipient = remainings[i_acc as usize].clone();
			let amount = amounts[i_req];
			let wd_id = wd_ids[i_req];

			require!(wd_id > last_wd_id, Error::InvalidWdId);

			if is_main {
				require!(wd_id >= wd_data.main_from_wd_id && wd_id <= wd_data.main_to_wd_id, Error::InvalidWdId);
			} 
			
			if create_ata_idxs.contains(&i_acc) {
				i_acc += 1;

				let wrecipient = remainings[i_acc as usize].clone();

				//create ata
				let cpi_accounts = Create {
					payer: signer.to_account_info(),
					associated_token: recipient.to_account_info(),
					authority: wrecipient.to_account_info(),
					mint: mint.to_account_info(),
					system_program: system_program.to_account_info(),
					token_program: token_program.to_account_info(),
				};
		
				let cpi_program = associated_token_program.to_account_info();
				let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
				associated_token::create(cpi_ctx)?;
			} 
			
			//transfer 
			let cpi_accounts = Transfer {
				from: ctx.accounts.funder.to_account_info(),
				to: recipient.to_account_info(), 
				authority: wd_agent.to_account_info(),
			};
			
			let cpi_ctx = CpiContext::new(token_program.to_account_info(), cpi_accounts).with_signer(signer_seeds);
			token_interface::transfer(cpi_ctx, amount)?;

			last_wd_id = wd_id;

			i_acc += 1;
			if i_acc >= remainings_len  {
				break;
			}

			i_req += 1;
			
		}

		if is_main {
			wd_data.main_from_wd_id = last_wd_id;
			if last_wd_id >= wd_data.main_to_wd_id {
				// off maintenance right away
				wd_data.main_to_wd_id = 0;
				wd_data.main_from_wd_id = 0;
			}
		} else {
			wd_data.last_wd_id = last_wd_id;

		}

		emit!(WdPayoutEvent { 
			merchant_executor: wd_agent.merchant.key(),
			wd_ids: wd_ids,
			their_wd_ids: their_wd_ids,
		});
		
		Ok(())
	}

	pub fn wd_payout_under_main(ctx: Context<WdPayoutUnderMain>, from_wd_id: u64, to_wd_id: u64) -> Result<()> {
		
		let wd_data = &mut ctx.accounts.wd_data;

		require!(ctx.accounts.signer.key() == wd_data.authority, Error::OnlyWdExecutor);
		require!(to_wd_id >= from_wd_id, Error::MainFromBiggerThanTo);
		require!(to_wd_id < wd_data.last_wd_id && from_wd_id < wd_data.last_wd_id, Error::MainWdIdMustLowerThanLastWdId);

		wd_data.main_from_wd_id = from_wd_id;
		wd_data.main_to_wd_id = to_wd_id;

		let wd_agent = &mut ctx.accounts.wd_agent;

		emit!(WdPayoutUnderMainEvent { 
			merchant_executor: wd_agent.merchant.key(),
			from_wd_id: from_wd_id,
			to_wd_id: to_wd_id,
		});
		
		Ok(())
	}
		
	pub fn get_sol_balances<'a, 'b, 'c, 'info>(ctx: Context<'a, 'b, 'c, 'info, GetSolBalances>) -> Result<String> {
		
		let mut balance_str: String = "".to_owned();
		let mut idx:u16 = 0;
		for recipient in ctx.remaining_accounts {
			let balance = recipient.to_account_info().lamports();
			
			if balance > 0 {
				balance_str.push_str(format!("{}", idx).as_str().as_ref());
				balance_str.push_str("-");
				balance_str.push_str(format!("{}", balance).as_str().as_ref());
				balance_str.push_str(",");
			}
			
			idx += 1;
		}
		
		Ok(balance_str)
	}
	
	pub fn get_token_balances<'a, 'b, 'c, 'info>(
		ctx: Context<'a, 'b, 'c, 'info, GetTokenBalances>
	)-> Result<String> {
		
		let mut balance_str: String = "".to_owned();
		let mut idx:u16 = 0;
		for dep_token_acc in ctx.remaining_accounts {
			
			let _dep_token_data = dep_token_acc.try_borrow_data()?;
			let mut slice_ref: &[u8] = &_dep_token_data;
            let res = TokenAccount::try_deserialize(&mut slice_ref);
			drop(_dep_token_data);
			
			if res.is_ok() {
				let dep_token_data = res.unwrap();

				if dep_token_data.amount > 0 {
					balance_str.push_str(format!("{}", idx).as_str().as_ref());
					balance_str.push_str("-");
					balance_str.push_str(format!("{}", dep_token_data.amount).as_str().as_ref());
					balance_str.push_str(",");
				}
			}
			
			idx += 1;
		}
		
		Ok(balance_str)
	}
	
	pub fn get_delegated_amounts<'a, 'b, 'c, 'info>(
		ctx: Context<'a, 'b, 'c, 'info, GetTokenBalances>
	)-> Result<String> {
		
		let mut balance_str: String = "".to_owned();
		let mut idx:u16 = 0;
		for dep_token_acc in ctx.remaining_accounts {
			
			let _dep_token_data = dep_token_acc.try_borrow_data()?;
			let mut slice_ref: &[u8] = &_dep_token_data;
            let res = TokenAccount::try_deserialize(&mut slice_ref);
			drop(_dep_token_data);
			
			if res.is_ok() {
				let dep_token_data = res.unwrap();

				if dep_token_data.delegated_amount > 0 {
					balance_str.push_str(format!("{}", idx).as_str().as_ref());
					balance_str.push_str("-");
					balance_str.push_str(format!("{}", dep_token_data.delegated_amount).as_str().as_ref());
					balance_str.push_str(",");
				}
			}
			
			idx += 1;
		}
		
		Ok(balance_str)
	}

	//===== PROGRAM =====
	pub fn init_program(ctx: Context<InitProgram>, wk_beneficiary: Pubkey) -> Result<()> {
		
		require!(OWNER == ctx.accounts.signer.key(), Error::OnlyOwner);
		
		let program_state = &mut ctx.accounts.program_state;
		program_state.authority = ctx.accounts.signer.key();
		program_state.wk_beneficiary = wk_beneficiary;
		program_state.bump = ctx.bumps.program_state;
		
		Ok(())
	}
	
	pub fn update_program(ctx: Context<UpdateProgram>, wk_beneficiary: Pubkey) -> Result<()> {


		let program_state = &mut ctx.accounts.program_state;
		
		require!(program_state.authority == ctx.accounts.signer.key(), Error::OnlyOwner);

		program_state.wk_beneficiary = wk_beneficiary;
		
		Ok(())
	}

	//===== MISC =====
	pub fn version(_ctx: Context<Version>) -> Result<String> {
        Ok(VERSION.to_string())
    }
	
}

//===== derive accounts =====

#[derive(Accounts)]
#[instruction(referral: Pubkey, beneficiaries: Vec<Pubkey>)]
pub struct Register<'info> {
	
	#[account(
        init, // create
        seeds = [b"merchant", signer.key().as_ref()],
        bump,
		payer = signer,
		space = ACC_DISCRI_LEN + size_of::<MerchantData>() + (beneficiaries.len() * ADDRESS_LEN),
    )]
    pub merchant_data: Account<'info, MerchantData>,
	
    #[account(mut)]
    pub signer: Signer<'info>,
	
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(beneficiaries: Vec<Pubkey>)]
pub struct DepUpdateBeneficiary<'info> {
	
	#[account(
        mut, 
        seeds = [b"merchant", signer.key().as_ref()],
        bump = merchant_data.bump,
		realloc = ACC_DISCRI_LEN + size_of::<MerchantData>() + (beneficiaries.len() * ADDRESS_LEN),
        realloc::payer = signer,
        realloc::zero = true,
    )]

    pub merchant_data: Account<'info, MerchantData>,
	
    #[account(mut)]
    pub signer: Signer<'info>,

	pub wk_signer: Signer<'info>,
	
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepFundoutSol<'info> {
	
	#[account(
        mut,
        seeds = [b"merchant", signer.key().as_ref()],
        bump = merchant_data.bump,
    )]
	pub merchant_data: Account<'info, MerchantData>,
	
	#[account(mut)]
    pub signer: Signer<'info>,

	#[account(mut)] 
	///CHECK
	pub beneficiary_acc: UncheckedAccount<'info>,
	
	#[account(mut)]
	///CHECK
	pub referral: UncheckedAccount<'info>,
	
	#[account(mut)]
	///CHECK
	pub wk_beneficiary: UncheckedAccount<'info>,
	 
	pub system_program: Program<'info, System>,
	
}


#[derive(Accounts)]
pub struct DepFundout<'info> {
	
	#[account(
        mut,
        seeds = [b"merchant", signer.key().as_ref()],
        bump = merchant_data.bump,
    )]
	pub merchant_data: Account<'info, MerchantData>,
	
	#[account(mut)]
    pub signer: Signer<'info>,

	#[account(mut)] 
	pub beneficiary_acc: InterfaceAccount<'info, TokenAccount>,
	
	#[account(mut)]
	pub referral: InterfaceAccount<'info, TokenAccount>,
	
	#[account(mut)]
	pub wk_beneficiary: InterfaceAccount<'info, TokenAccount>,
	
	pub token_program: Interface<'info, TokenInterface>,
	 
	pub system_program: Program<'info, System>,
	
}

#[derive(Accounts)]
pub struct WdEnable<'info> {
	#[account(mut)]
    pub signer: Signer<'info>,
	pub wk_signer: Signer<'info>,
	///CHECK
	pub wd_executor: UncheckedAccount<'info>,
	
	#[account(
        mut, 
        seeds = [b"merchant", signer.key().as_ref()],
        bump = merchant_data.bump,
    )]
    pub merchant_data: Account<'info, MerchantData>,
	
	
	/*
	#[account(
        mut, 	
        seeds = [b"wdagent", wd_executor.key().as_ref()],
        bump = wd_agent.bump,
    )]
	*/
	#[account(
        init, 
        seeds = [b"wdagent", wd_executor.key().as_ref()],
        bump,
		payer = signer,
		space = ACC_DISCRI_LEN + size_of::<WdAgent>(),
    )]
	pub wd_agent: Account<'info, WdAgent>,
	
	pub system_program: Program<'info, System>,
	
}


#[derive(Accounts)]
pub struct Version {
    // Empty, as no accounts are required for this read-only function
}

#[derive(Accounts)]
pub struct GetSolBalances {

}

#[derive(Accounts)]
pub struct GetTokenBalances {

}

#[derive(Accounts)]
pub struct InitProgram<'info> {
	
	#[account(
        init, 
		payer = signer, 
		space = ACC_DISCRI_LEN + size_of::<ProgramState>(),
		seeds = [b"programstate", signer.key().as_ref()],
        bump,
    )]
    pub program_state: Account<'info, ProgramState>,

    #[account(mut)]
    pub signer: Signer<'info>,
	
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProgram<'info> {
	#[account(
		mut,
		seeds = [b"programstate", signer.key().as_ref()],
        bump = program_state.bump,
	)]
    pub program_state: Account<'info, ProgramState>,
	
    #[account(mut)]
    pub signer: Signer<'info>,
	
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CheckTxFees {} // misc

#[derive(Accounts)]
pub struct WdSupplyExecutorGas<'info> {
	
	#[account(
        mut, 
        seeds = [b"merchant", signer.key().as_ref()],
        bump = merchant_data.bump,
    )]
    pub merchant_data: Account<'info, MerchantData>,
	
	#[account(mut)]
	///CHECK:
	pub wd_executor: UncheckedAccount<'info>,
	
	#[account(mut)]
    pub signer: Signer<'info>,
	
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WdSupplyRolling<'info> {
	
	#[account(
        mut, 
        seeds = [b"merchant", signer.key().as_ref()],
        bump = merchant_data.bump,
    )]
    pub merchant_data: Account<'info, MerchantData>,
	
	#[account(mut)]
    pub signer: Signer<'info>, //merchant executor
	
	#[account(mut)]
	pub merchant_token: InterfaceAccount<'info, TokenAccount>, 
	
	#[account(mut)]
	pub wd_token: InterfaceAccount<'info, TokenAccount>, 
	
	pub token_program: Interface<'info, TokenInterface>,
	
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepSupplyApprovalGas<'info> {
	
	#[account(
        mut, 
        seeds = [b"merchant", signer.key().as_ref()],
        bump = merchant_data.bump,
    )]
    pub merchant_data: Account<'info, MerchantData>,
	
	#[account(mut)]
	signer: Signer<'info>,
	
	system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WdPayoutUnderMain<'info> {

	#[account(mut)]
    pub signer: Signer<'info>, //wdExecutor

	#[account(
        mut,
        seeds = [b"wdagent", signer.key().as_ref()],
        bump = wd_agent.bump,
    )]
    pub wd_agent: Account<'info, WdAgent>, 

	#[account(
		mut, 
		seeds = [b"wddata", signer.key().as_ref(), funder.mint.key().as_ref()],
		bump = wd_data.bump,
		/*
		realloc = ACC_DISCRI_LEN + size_of::<WdData>(),
        realloc::payer = signer,
        realloc::zero = true,
		*/
	)]
    pub wd_data: Account<'info, WdData>,

	#[account(mut)]
    pub funder: InterfaceAccount<'info, TokenAccount>, 

	pub system_program: Program<'info, System>,
	
}

#[derive(Accounts)]
pub struct WdPayout<'info> {
	#[account(
        mut,
        seeds = [b"wdagent", signer.key().as_ref()],
        bump = wd_agent.bump,
    )]
    pub wd_agent: Account<'info, WdAgent>, 
	#[account(
		init_if_needed,
		payer = signer,
		space = ACC_DISCRI_LEN + size_of::<WdData>(),
		seeds = [b"wddata", signer.key().as_ref(), funder.mint.key().as_ref()],
		bump
	)]
    pub wd_data: Account<'info, WdData>,
    #[account(mut)]
    pub signer: Signer<'info>, //wdexecutor
	#[account(mut)]
    pub funder: InterfaceAccount<'info, TokenAccount>, // TA of wdexecutor
	pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

	pub mint: InterfaceAccount<'info, Mint>,
	pub associated_token_program: Program<'info, AssociatedToken>,
	pub rent: Sysvar<'info, Rent>,	
}


#[derive(Accounts)]
pub struct CreateTokenAcc<'info> { // misc
	#[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = wallet_recipient,
    )]
    pub recipient: InterfaceAccount<'info, TokenAccount>, // The new associated token account
	
	///CHECK:
	pub wallet_recipient: UncheckedAccount<'info>,
	
	#[account(mut)]
	pub signer: Signer<'info>,
	
	pub mint: InterfaceAccount<'info, Mint>,
	pub associated_token_program: Program<'info, AssociatedToken>,
	pub system_program: Program<'info, System>,
	pub token_program: Interface<'info, TokenInterface>,
	pub rent: Sysvar<'info, Rent>,	
}


//===== account =====

#[account]
pub struct WdAgent { // authority to do payout
	pub authority: Pubkey, // wdexecutor
	pub merchant: Pubkey, // merchant-executor
	pub bump: u8,
}

#[account]
pub struct WdData{
	pub authority: Pubkey, // wdexecutor
	pub last_wd_id: u64,
	pub main_from_wd_id: u64,
	pub main_to_wd_id: u64,
	pub bump: u8,
}

#[account]
pub struct MerchantData {
	pub authority: Pubkey, // merchant-wallet
	pub bump: u8,
	pub referral: Pubkey,
	pub wd_executor: Pubkey,
	pub beneficiaries: Vec<Pubkey>,
}

#[account]
pub struct ProgramState {
	pub authority: Pubkey, // program-wallet
    pub wk_beneficiary: Pubkey,
	pub bump: u8,	
}

//===== event =====
#[event]
pub struct RegisterEvent {
    pub merchant_executor: Pubkey,
	pub referral: Pubkey,
	pub beneficiaries: Vec<Pubkey>,
	pub merchant_data: Pubkey,
}

#[event]
pub struct WdEnableEvent {
	pub merchant_executor: Pubkey,
	pub wd_executor:Pubkey,
}

#[event]
pub struct DepUpdateBeneficiaryEvent {
	pub merchant_executor: Pubkey,
}

#[event]
pub struct DepFundoutEvent {
    pub merchant_executor: Pubkey,
	pub mint: Pubkey,
	pub fundout: u128,
}

#[event]
pub struct DepSupplyApprovalGasEvent {
	pub merchant_executor:Pubkey,
	pub batch_id: u64,
	pub supply_gas: u128,
	
}

#[event]
pub struct WdPayoutUnderMainEvent {
	pub merchant_executor: Pubkey,
	pub from_wd_id: u64,
	pub to_wd_id: u64,
}

#[event]
pub struct WdPayoutEvent {
	pub merchant_executor: Pubkey,
	pub wd_ids: Vec<u64>,
	pub their_wd_ids: Vec<u64>,
}

#[event]
pub struct WdSupplyExecutorGasEvent {
	pub merchant_executor: Pubkey,
	pub supply_gas: u64,
}

#[event]
pub struct WdSupplyRollingEvent {
	pub merchant_executor: Pubkey,
	pub merchant_token: Pubkey,
	pub amount: u64,
}

//===== error =====
#[error_code]
pub enum Error {
    #[msg("invalid beneficiary")]
	InvalidBeneficiary,
	#[msg("invalid mint")]
	InvalidMint,
	#[msg("invalid wk beneficiary")]
	InvalidWkBeneficiary,
	#[msg("invalid owner")]
	OnlyOwner,
	#[msg("invalid referral ata")]
	InvalidRefAta,
	#[msg("invalid wk signer")]
	InvalidWkSigner,
	#[msg{"invalid wd id"}]
	InvalidWdId,
	#[msg{"no deposit account"}]
	NoDepositAccount,
	#[msg("recipients mismatch with amounts")]
    MismatchedRecipientAmounts,
	#[msg("only merchant")]
	OnlyMerchant,
	#[msg("only wd executor")]
	OnlyWdExecutor,
	#[msg("from must lower than to")]
	MainFromBiggerThanTo,
	#[msg("cannot more than last wd id")]
	MainWdIdMustLowerThanLastWdId,
	#[msg("invalid on-curve pubkey")]
	InvalidOnCurvePubkey,
	#[msg("invalid referral")]
	InvalidReferral
}
