use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::solana_program::rent::Rent;

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "HAiO Transaction Gateway Program",
    project_url: "https://haio.fun",
    contacts: "email:cto@haio.fun",
    policy: "We do not pay a bug bounty.",
    preferred_languages: "en",
    source_code: "https://github.com/HAiO-labs/solana-programs",
    source_revision: "main"
}

declare_id!("HaioYYCZuXWxiHjFG9i8MnzAH6dFdgh1E1eCGjTwWzb");

/// Bump the reserved size to at least 1 KB so later upgrades
/// (e.g. multi-token support) can reuse the same account without realloc.
/// Configuration space for PDAs (includes discriminator)
pub const CONFIG_SPACE: usize = 1024; // Fixed size for membership config

/// Fixed size constants for deposit realloc calculations
pub const DEPOSIT_FIXED: usize = 32 + 32 + 4; // admin + deposit_wallet + vec len prefix
pub const PUBKEY_SIZE: usize = 32; // single pubkey size

#[program]
pub mod transaction_gateway {
    use super::*;

    /// Initialize membership configuration
    pub fn initialize_membership_config(
        ctx: Context<InitializeMembershipConfig>,
        admin: Pubkey,
        treasury: Pubkey,
        fees: Vec<MembershipFee>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.treasury = treasury;
        config.fees = fees;
        
        msg!("Membership config initialized");
        Ok(())
    }

    /// Initialize deposit configuration
    pub fn initialize_deposit_config(
        ctx: Context<InitializeDepositConfig>,
        admin: Pubkey,
        deposit_wallet: Pubkey,
        allowed_mints: Vec<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.deposit_wallet = deposit_wallet;
        config.allowed_mints = allowed_mints;
        
        msg!("Deposit config initialized");
        Ok(())
    }

    /// Pay membership fee
    pub fn pay_membership(
        ctx: Context<PayMembership>,
        mint: Pubkey,
        amount: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.cfg;
        
        // Find matching fee
        let fee = config.fees.iter()
            .find(|f| f.mint == mint)
            .ok_or(ErrorCode::UnsupportedMint)?;
        
        // Validate amount
        require!(amount == fee.monthly_fee || amount == fee.yearly_fee, ErrorCode::WrongFee);
        
        // Transfer assets
        transfer_asset(
            &mint,
            amount,
            ctx.accounts.user.to_account_info(),
            ctx.accounts.user_ata.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
            ctx.accounts.treasury_ata.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.mint.to_account_info(),
        )?;
        
        // Emit event
        emit!(MembershipPaid {
            user: ctx.accounts.user.key(),
            mint,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        msg!("Membership payment successful");
        Ok(())
    }

    /// Make a deposit
    pub fn deposit(
        ctx: Context<Deposit>,
        mint: Pubkey,
        amount: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.cfg;
        
        // Check if mint is allowed
        require!(
            config.allowed_mints.contains(&mint),
            ErrorCode::UnsupportedMint
        );
        
        // Transfer assets
        transfer_asset(
            &mint,
            amount,
            ctx.accounts.user.to_account_info(),
            ctx.accounts.user_ata.to_account_info(),
            ctx.accounts.deposit_wallet.to_account_info(),
            ctx.accounts.deposit_ata.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.mint.to_account_info(),
        )?;
        
        // Emit event
        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            mint,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        msg!("Deposit successful");
        Ok(())
    }

    /// Update membership config (admin only)
    pub fn update_membership_config(
        ctx: Context<UpdateMembershipConfig>,
        admin: Pubkey,
        treasury: Pubkey,
        fees: Vec<MembershipFee>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.treasury = treasury;
        config.fees = fees;
        
        msg!("Membership config updated");
        Ok(())
    }

    /// Update deposit config (admin only)
    pub fn update_deposit_config(
        ctx: Context<UpdateDepositConfig>,
        admin: Pubkey,
        deposit_wallet: Pubkey,
        allowed_mints: Vec<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        
        // Calculate required space for the new allowed_mints
        let required_space = DEPOSIT_FIXED + PUBKEY_SIZE * allowed_mints.len() + 8;
        let current_space = config.to_account_info().data_len();
        
        // Realloc if needed
        if required_space > current_space {
            // Calculate rent first
            let rent = Rent::get()?;
            let new_minimum_balance = rent.minimum_balance(required_space);
            let lamports_diff = new_minimum_balance.saturating_sub(config.to_account_info().lamports());
            
            // Transfer rent if needed (before resize)
            if lamports_diff > 0 {
                anchor_lang::solana_program::program::invoke(
                    &anchor_lang::solana_program::system_instruction::transfer(
                        &ctx.accounts.admin.key(),
                        &config.key(),
                        lamports_diff,
                    ),
                    &[
                        ctx.accounts.admin.to_account_info(),
                        config.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;
            }
            
            // Now resize and zero-fill new bytes
            config.to_account_info().resize(required_space)?;
        }
        
        config.admin = admin;
        config.deposit_wallet = deposit_wallet;
        config.allowed_mints = allowed_mints;
        
        msg!("Deposit config updated");
        Ok(())
    }

    /// Change admin (admin only)
    pub fn change_membership_admin(
        ctx: Context<ChangeMembershipAdmin>,
        new_admin: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = new_admin;
        
        msg!("Membership admin changed");
        Ok(())
    }

    /// Change deposit admin (admin only)
    pub fn change_deposit_admin(
        ctx: Context<ChangeDepositAdmin>,
        new_admin: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = new_admin;
        
        msg!("Deposit admin changed");
        Ok(())
    }
}
/// Transfer assets (SOL or SPL tokens) to destination
fn transfer_asset<'info>(
    mint_key: &Pubkey,
    amount: u64,
    user: AccountInfo<'info>,
    user_ata: AccountInfo<'info>,
    treasury: AccountInfo<'info>,
    treasury_ata: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    mint_account: AccountInfo<'info>,
) -> Result<()> {
    if *mint_key == anchor_lang::system_program::ID {
        // SOL transfer
        let cpi = anchor_lang::system_program::Transfer {
            from: user.clone(),
            to: treasury.clone(),
        };
        anchor_lang::system_program::transfer(
            CpiContext::new(system_program.clone(), cpi),
            amount,
        )
    } else {
        // SPL token transfer
        require!(mint_account.owner == &anchor_spl::token::ID, ErrorCode::UnsupportedMint);
        require!(user_ata.owner == &anchor_spl::token::ID, ErrorCode::InvalidTokenAccount);
        require!(treasury_ata.owner == &anchor_spl::token::ID, ErrorCode::InvalidTokenAccount);
        
        // Use spl_token::state::Mint::unpack for better compatibility
        let mint_data = spl_token::state::Mint::unpack(&mint_account.data.borrow())?;
        
        // Additional ATA-mint validation
        let user_ata_data = spl_token::state::Account::unpack(&user_ata.data.borrow())?;
        let treasury_ata_data = spl_token::state::Account::unpack(&treasury_ata.data.borrow())?;
        require!(user_ata_data.mint == *mint_key, ErrorCode::MintMismatch);
        require!(treasury_ata_data.mint == *mint_key, ErrorCode::MintMismatch);
        let cpi = TransferChecked {
            from: user_ata.clone(),
            to: treasury_ata.clone(),
            authority: user.clone(),
            mint: mint_account.clone(),
        };
        token::transfer_checked(
            CpiContext::new(token_program.clone(), cpi),
            amount,
            mint_data.decimals,
        )
    }
}

/// Membership payment event
#[event]
pub struct MembershipPaid {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

/// Deposit event
#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

/// Membership configuration PDA
/// seeds = [b"membership_config"]
#[account]
pub struct MembershipConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,               // Treasury wallet for membership payments
    pub fees: Vec<MembershipFee>,       // SOL + SPL tokens (expandable)
}

/// Mint-specific fee structure
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MembershipFee {
    pub mint: Pubkey, // SOL = SystemProgram::ID
    pub monthly_fee: u64,    // lamports / token-units
    pub yearly_fee: u64,
}

/// Deposit configuration PDA
/// seeds = [b"deposit_config"]
#[account]
pub struct DepositConfig {
    pub admin: Pubkey,
    pub deposit_wallet: Pubkey,         // Deposit wallet for general deposits
    pub allowed_mints: Vec<Pubkey>,     // Whitelist including SOL
}

#[derive(Accounts)]
pub struct InitializeMembershipConfig<'info> {
    /// Creates and pays rent for the singleton `MembershipConfig` PDA.
    #[account(
        init,
        payer = admin,
        space = CONFIG_SPACE,
        seeds = [b"membership_config"],
        bump
    )]
    config: Account<'info, MembershipConfig>,

    /// External wallet that finally holds membership payments.
    /// Treated as `UncheckedAccount` to support any key type (EOA, multisig).
    /// CHECK: Validated by address constraint in PayMembership
    #[account(mut)]
    treasury: UncheckedAccount<'info>,

    #[account(mut)]
    admin: Signer<'info>,

    system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeDepositConfig<'info> {
    /// Creates and pays rent for the singleton `DepositConfig` PDA.
    #[account(
        init,
        payer = admin,
        space = CONFIG_SPACE,
        seeds = [b"deposit_config"],
        bump
    )]
    config: Account<'info, DepositConfig>,

    /// External wallet for deposits.
    /// Treated as `UncheckedAccount` to support any key type (EOA, multisig).
    /// CHECK: Validated by address constraint in Deposit
    #[account(mut)]
    deposit_wallet: UncheckedAccount<'info>,

    #[account(mut)]
    admin: Signer<'info>,

    system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayMembership<'info> {
    #[account(mut)]
    user: Signer<'info>,

    #[account(
        seeds = [b"membership_config"],
        bump
    )]
    cfg: Account<'info, MembershipConfig>,

    /// Must match `cfg.treasury`.
    /// CHECK: Validated by address constraint
    #[account(mut, address = cfg.treasury)]
    treasury: UncheckedAccount<'info>,

    // Programs
    // ───── programs ─────
    system_program: Program<'info, System>,
    #[account(address = anchor_spl::token::ID)]
    token_program: Program<'info, Token>,

    // ───── unsafe accounts ─────
    /// CHECK:  
    /// For *SOL payments*, arbitrary (non-existent) keys can be passed, so format validation is not required.  
    /// For *SPL payments*, `transfer_asset()` internally validates actual TokenAccount existence and mint matching
    #[account(mut)]
    user_ata:     UncheckedAccount<'info>,

    /// CHECK: Same rationale as `user_ata`
    #[account(mut)]
    treasury_ata: UncheckedAccount<'info>,

    /// CHECK: mint Pubkey is passed as-is for SOL (= SystemProgram::ID) or actual SPL Mint.
    #[account()]
    mint: UncheckedAccount<'info>,

}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    user: Signer<'info>,

    #[account(
        seeds = [b"deposit_config"],
        bump
    )]
    cfg: Account<'info, DepositConfig>,

    /// Must match `cfg.deposit_wallet`.
    /// CHECK: Validated by address constraint
    #[account(mut, address = cfg.deposit_wallet)]
    deposit_wallet: UncheckedAccount<'info>,

    // Programs
    system_program: Program<'info, System>,
    #[account(address = anchor_spl::token::ID)]
    token_program: Program<'info, Token>,

    // SPL accounts (dummy for SOL deposits)
    #[account(mut)]
    user_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    deposit_ata: Account<'info, TokenAccount>,
    /// CHECK: Validated in transfer_asset function
    #[account()]
    mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateMembershipConfig<'info> {
    #[account(mut, seeds = [b"membership_config"], bump, has_one = admin)]
    config: Account<'info, MembershipConfig>,
    admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateDepositConfig<'info> {
    #[account(
        mut,
        seeds = [b"deposit_config"],
        bump,
        has_one = admin
    )]
    config: Account<'info, DepositConfig>,
    #[account(mut)]
    admin: Signer<'info>,
    system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ChangeMembershipAdmin<'info> {
    #[account(mut, seeds = [b"membership_config"], bump, has_one = admin)]
    config: Account<'info, MembershipConfig>,
    admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ChangeDepositAdmin<'info> {
    #[account(mut, seeds = [b"deposit_config"], bump, has_one = admin)]
    config: Account<'info, DepositConfig>,
    admin: Signer<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unsupported mint")]
    UnsupportedMint,
    #[msg("Wrong fee amount")]
    WrongFee,
    #[msg("Invalid token account")]
    InvalidTokenAccount,
    #[msg("Mint mismatch")]
    MintMismatch,
}

