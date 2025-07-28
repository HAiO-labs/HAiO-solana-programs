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

declare_id!("HaiooUZ4qzSEi2sn1qbwH8mKVXgnwY8oyziUStJDcb6Z");

#[program]
pub mod withdrawal_logger {
    use super::*;

    /// Logs the requested withdrawal amount.
    /// 
    /// * `ticker` must be 2–8 ASCII letters (A‑Z, 0‑9, _) to keep the
    /// * `amount` is already adjusted for decimals by the front‑end.
    pub fn request_withdrawal(
        _ctx: Context<RequestWithdrawal>,
        ticker: String,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, WithdrawalLoggerError::InvalidAmount);
        require!(ticker.len() >= 2 && ticker.len() <= 8, WithdrawalLoggerError::BadTicker);
        require!(
            ticker
                .bytes()
                .all(|b| matches!(b, b'A'..=b'Z' | b'0'..=b'9' | b'_')),
            WithdrawalLoggerError::BadTicker,
        );

        // Example: WITHDRAWAL=USDC,1500
        msg!("WITHDRAWAL={},{}", ticker, amount);
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
    #[msg("Ticker must be 2–8 printable ASCII chars (A‑Z, 0‑9, _)")]
    BadTicker,
}
