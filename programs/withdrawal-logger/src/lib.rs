use anchor_lang::prelude::*;

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "HAiO Withdrawal Logger Program",
    project_url: "https://haio.fun",
    contacts: "email:cto@haio.fun",
    policy: "We do not pay a bug bounty.",
    preferred_languages: "en",
    source_code: "https://github.com/HAiO-labs/solana-programs",
    source_revision: "main"
}

declare_id!("HAiowc2WWGp3VwVjpAtiduLCwWQmQqVPQgLbn5jurM8o");

#[program]
pub mod withdrawal_logger {
    use super::*;

    /// Logs the requested withdrawal amount.
    pub fn request_withdrawal(_ctx: Context<RequestWithdrawal>, amount: u64) -> Result<()> {
        require!(amount > 0, WithdrawalLoggerError::InvalidAmount);

        msg!("WITHDRAW={}", amount);
        Ok(())
    }
}

/// No additional accounts are required; the caller just signs the tx.
#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    pub user: Signer<'info>,
}

#[error_code]
pub enum WithdrawalLoggerError {
    #[msg("Amount must be greater than 0")]
    InvalidAmount,
}
