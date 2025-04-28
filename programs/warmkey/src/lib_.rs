use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::associated_token::{self, get_associated_token_address};

declare_id!("FJeV4XT5gPHbDZEbLwGqoZUwdmn5Rzu91A1PstzggShg");

const ACC_DISCRI_LEN: usize = 8;
const MERCHANT_ADDRESS_LEN: usize = 32;
const PDA_BUMPSEED_LEN: usize = 1;

#[program]
pub mod warmkey {
    use super::*;

    pub fn register(ctx: Context<Register>) -> Result<()> {

		let merchant_data = &mut ctx.accounts.merchant_acc;
		merchant_data.user = ctx.accounts.sender_acc.key();
		merchant_data.bump = ctx.bumps.merchant_acc;

        msg!("merchant's creator: {}", merchant_data.user);
        msg!("merchant's account: {}", ctx.accounts.merchant_acc.key());
        Ok(())
    }

    pub fn fundout_token(ctx: Context<FundoutToken>, table_id: u128, record_id: u128) -> Result<()> {

        // Fetch the balance of the deposit token account
        let deposit_acc = &ctx.accounts.deposit_acc;
        let token_acc = get_associated_token_address(&deposit_acc.key(), &ctx.accounts.token_program.key());

        /*
        let merchant_data = &mut ctx.accounts.merchant_acc;
        

        let cpi_accounts = Transfer {
            from: deposit_acc.to_account_info(),
            to: deposit_acc.to_account_info(), //ctx.accounts.beneficiary_token_acc.to_account_info(),
            authority: ctx.accounts.program_signer.to_account_info(),
        };

        let merchant_key: Pubkey = ctx.accounts.merchant_acc.key();
        let signer_seeds: &[&[&[u8]]] = &[&[b"signer", merchant_key.as_ref(), &[ctx.bumps.program_signer]]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        // Perform the transfer of SPL token
        token::transfer(cpi_ctx, deposit_balance)?;
        */
        Ok(())
    }
}

#[derive(Accounts)]
/* atlas: 'info is a lifetime that tells Anchor how long these account references live. */
pub struct Register<'info> {
	
	#[account(mut)]
	pub sender_acc: Signer<'info>,
	
	#[account(
        init, // create
        seeds = [b"merchant", sender_acc.key().as_ref()],
        bump,
		payer = sender_acc,
		space = ACC_DISCRI_LEN + MERCHANT_ADDRESS_LEN + PDA_BUMPSEED_LEN
    )]
    pub merchant_acc: Account<'info, MerchantAcc>,

	pub system_program: Program<'info, System>,
	
}

#[derive(Accounts)]
#[instruction(table_id: u128, record_id: u128)]
pub struct FundoutToken<'info> {
    #[account(mut)] // modify
    pub sender_acc: Signer<'info>,

    #[account(
        mut,
        seeds = [b"merchant", sender_acc.key().as_ref()],
        bump = merchant_acc.bump,
        realloc = ACC_DISCRI_LEN + MERCHANT_ADDRESS_LEN + PDA_BUMPSEED_LEN,
        realloc::payer = sender_acc,
        realloc::zero = true,
    )]
    pub merchant_acc: Account<'info, MerchantAcc>,

    #[account(mut, seeds = [b"deposit", merchant_acc.key().as_ref(), &table_id.to_be_bytes(), &record_id.to_be_bytes()], bump)]
    pub deposit_acc: SystemAccount<'info>,

    #[account(seeds = [b"signer", merchant_acc.key().as_ref()], bump)]
    pub program_signer: SystemAccount<'info>, 

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,

}

#[account]
/* atlas: struct here don’t need 'info, because it didnt refer real acc during tx exec */
pub struct MerchantAcc {
    pub user: Pubkey,
    pub bump: u8,
    /* add beneficiary address */
}

