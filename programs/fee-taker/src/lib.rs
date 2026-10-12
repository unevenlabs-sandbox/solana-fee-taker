use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

//----------------------------------------
// Constants
//----------------------------------------

pub const FEE_TAKER_SEED: &[u8] = b"fee_taker";

//----------------------------------------
// Program ID
//----------------------------------------

declare_id!("3mB3kHbyvn45hZ87Lp93wY5oKBrAeqKCgRE1mHj9PYYg");

//----------------------------------------
// Program Module
//----------------------------------------

/// Stateless utility for collecting a fixed fee without an extra swap.
///
/// Funds (the output of a swap, or a direct deposit) are sent to the fee taker
/// PDA (native) or its associated token account (spl / token-2022). In the
/// same transaction, `take_*` sends `fee_amount` of the balance to a fee
/// recipient (the solver, tracked off-chain) and the rest to `recipient`
/// (typically the relay forwarder, which forwards it into the depository in
/// the next instruction).
///
/// If `fee_amount` exceeds the balance, no fee is taken and the whole balance
/// goes to `recipient`.
///
/// The program holds no state and does not restrict recipients, so funds must
/// never be left resting in the fee taker accounts across transactions.
#[program]
pub mod fee_taker {
    use super::*;

    /// Forwards the full balance of the fee taker's token account for `mint`:
    /// `fee_amount` to `fee_token_account` and the rest to
    /// `recipient_token_account`.
    pub fn take_token(ctx: Context<TakeToken>, id: [u8; 32], fee_amount: u64) -> Result<()> {
        let amount = ctx.accounts.fee_taker_token_account.amount;
        require!(amount > 0, FeeTakerError::InsufficientBalance);

        let (fee, remainder) = split_amount(amount, fee_amount);

        let seeds: &[&[&[u8]]] = &[&[FEE_TAKER_SEED, &[ctx.bumps.fee_taker]]];
        let decimals = ctx.accounts.mint.decimals;

        if fee > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.fee_taker_token_account.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.fee_token_account.to_account_info(),
                        authority: ctx.accounts.fee_taker.to_account_info(),
                    },
                    seeds,
                ),
                fee,
                decimals,
            )?;
        }

        if remainder > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.fee_taker_token_account.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.recipient_token_account.to_account_info(),
                        authority: ctx.accounts.fee_taker.to_account_info(),
                    },
                    seeds,
                ),
                remainder,
                decimals,
            )?;
        }

        emit!(FeeTaken {
            id,
            mint: Some(ctx.accounts.mint.key()),
            amount,
            requested_fee_amount: fee_amount,
            fee_amount: fee,
            remainder_amount: remainder,
            fee_recipient: ctx.accounts.fee_token_account.key(),
            recipient: ctx.accounts.recipient_token_account.key(),
        });

        Ok(())
    }

    /// Forwards the native balance of the fee taker PDA (above the rent-exempt
    /// minimum, which stays in the PDA): `fee_amount` to `fee_recipient` and
    /// the rest to `recipient`.
    pub fn take_native(ctx: Context<TakeNative>, id: [u8; 32], fee_amount: u64) -> Result<()> {
        let min_rent = Rent::get()?.minimum_balance(0);
        let amount = ctx
            .accounts
            .fee_taker
            .lamports()
            .checked_sub(min_rent)
            .ok_or(FeeTakerError::InsufficientBalance)?;
        require!(amount > 0, FeeTakerError::InsufficientBalance);

        let (fee, remainder) = split_amount(amount, fee_amount);

        let seeds: &[&[&[u8]]] = &[&[FEE_TAKER_SEED, &[ctx.bumps.fee_taker]]];

        if fee > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.fee_taker.to_account_info(),
                        to: ctx.accounts.fee_recipient.to_account_info(),
                    },
                    seeds,
                ),
                fee,
            )?;
        }

        if remainder > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.fee_taker.to_account_info(),
                        to: ctx.accounts.recipient.to_account_info(),
                    },
                    seeds,
                ),
                remainder,
            )?;
        }

        emit!(FeeTaken {
            id,
            mint: None,
            amount,
            requested_fee_amount: fee_amount,
            fee_amount: fee,
            remainder_amount: remainder,
            fee_recipient: ctx.accounts.fee_recipient.key(),
            recipient: ctx.accounts.recipient.key(),
        });

        Ok(())
    }
}

/// Returns `(fee, remainder)`: `(fee_amount, amount - fee_amount)` when the
/// fee fits in `amount`, otherwise `(0, amount)` so the whole balance goes to
/// the recipient.
fn split_amount(amount: u64, fee_amount: u64) -> (u64, u64) {
    match amount.checked_sub(fee_amount) {
        Some(remainder) => (fee_amount, remainder),
        None => (0, amount),
    }
}

//----------------------------------------
// Instruction Contexts
//----------------------------------------

#[derive(Accounts)]
#[instruction(id: [u8; 32], fee_amount: u64)]
pub struct TakeToken<'info> {
    /// CHECK: Fee taker PDA, authority of `fee_taker_token_account`
    #[account(seeds = [FEE_TAKER_SEED], bump)]
    pub fee_taker: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// Associated token account of the fee taker PDA holding the funds
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = fee_taker,
        associated_token::token_program = token_program,
    )]
    pub fee_taker_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Token account receiving the fee (the solver's, tracked off-chain)
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub fee_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Token account receiving the remainder (typically the relay forwarder's)
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(id: [u8; 32], fee_amount: u64)]
pub struct TakeNative<'info> {
    /// CHECK: Fee taker PDA holding the lamports
    #[account(mut, seeds = [FEE_TAKER_SEED], bump)]
    pub fee_taker: UncheckedAccount<'info>,

    /// CHECK: Account receiving the fee (the solver, tracked off-chain)
    #[account(mut)]
    pub fee_recipient: UncheckedAccount<'info>,

    /// CHECK: Account receiving the remainder (typically the relay forwarder PDA)
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

//----------------------------------------
// Events
//----------------------------------------

#[event]
pub struct FeeTaken {
    /// Request id the fee belongs to (same id passed to the forwarder)
    pub id: [u8; 32],
    /// Token mint, or `None` for native SOL
    pub mint: Option<Pubkey>,
    /// Total balance that was forwarded
    pub amount: u64,
    /// Fee passed to the instruction
    pub requested_fee_amount: u64,
    /// Amount actually sent to `fee_recipient` (0 if the requested fee exceeded the balance)
    pub fee_amount: u64,
    /// Amount sent to `recipient`
    pub remainder_amount: u64,
    pub fee_recipient: Pubkey,
    pub recipient: Pubkey,
}

//----------------------------------------
// Error Definitions
//----------------------------------------

#[error_code]
pub enum FeeTakerError {
    #[msg("Insufficient balance")]
    InsufficientBalance,
}
