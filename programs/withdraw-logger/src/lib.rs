use anchor_lang::prelude::*;

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "HAiO Withdraw Logger Program",
    project_url: "https://haio.fun",
    contacts: "email:cto@haio.fun",
    policy: "We do not pay a bug bounty.",
    preferred_languages: "en",
    source_code: "https://github.com/HAiO-labs/solana-programs",
    source_revision: "main"
}

declare_id!("HAiowc2WWGp3VwVjpAtiduLCwWQmQqVPQgLbn5jurM8o");

#[program]
pub mod withdraw_logger {
    use super::*;

    /// Logs the requested withdrawal amount.
    pub fn request_withdraw(_ctx: Context<RequestWithdraw>, amount: u64) -> Result<()> {
        msg!("WITHDRAW={}", amount);
        Ok(())
    }
}

/// No additional accounts are required; the caller just signs the tx.
#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(signer)]
    pub user: AccountInfo<'info>,
}
