//! Transaction-scope validity policy for a Fanfare artist chain.
//!
//! Base consensus lets any signer write any general-state key. This policy
//! allows four shapes of key:
//!
//! - `user/<owner>/...`: the owner's own records.
//! - `index/.../<owner>`: the owner's entry under a shared topic, so a topic
//!   can be listed by prefix without knowing who wrote to it.
//! - `item/<seller>/<name>`: the seller's listing of an item.
//! - `own/<seller>/<id>`: one token, such as a ticket.
//!
//! For the first three, the owner or seller segment must be one of the
//! transaction's signers, and the owner may create, overwrite or delete the
//! key, except that a listing is never deleted.
//!
//! Only the seller mints a token, so every token is backed by its seller. The
//! id is the seller's to choose, in one or more segments (for example
//! `berlin-night-1/A12`, so a show's tickets share a prefix). A token's value is
//! its holder, `<holder>`, or its holder with an asking price,
//! `<holder>@<price>`. The holder may change a token in any way: transfer it,
//! set or change a price, or take it off sale. Anyone else may take a token
//! that has a price by paying the holder at least that price in the same
//! transaction. Nobody may delete a token. Consensus checks every declared old
//! value against the chain, so the old value is the token's real holder and
//! price, and an empty one means the token does not exist yet.
//!
//! What the records mean is up to clients. Coin actions pass untouched.
//!
//! The context reading and the token rule are `lattice-policy-rules`, shared
//! with the profile chain's policy.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{transaction_body, Action, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    transaction_body(context).and_then(check_body).is_some()
}

fn check_body(bytes: &[u8]) -> Option<()> {
    let body = Body::parse(bytes)?;
    for action in body.actions()? {
        let action = action?;
        match token(action.key)? {
            // Only the seller mints, so every token is backed by its seller.
            Some(token) => body.check_token_write(&action, |_| body.is_signer(token.seller))?,
            None => check_owned(&body, &action)?,
        }
    }
    // Every key reaching here passed `token`, so `own/` names a token.
    body.check_payments(|key| key.starts_with(b"own/"))
}

fn check_owned(body: &Body, action: &Action) -> Option<()> {
    let mut segments = action.key.split(|&byte| byte == b'/');
    let owner = match segments.next()? {
        b"user" => segments.next()?,
        b"index" => {
            segments.next()?; // at least one topic segment
            segments.last()?
        }
        // A listing outlives its tokens' trades: they point at it, so it is
        // never deleted.
        b"item" => {
            let seller = named(&mut segments)?;
            if action.new_value.is_none() {
                return None;
            }
            seller
        }
        _ => return None,
    };
    body.is_signer(owner)
}

struct Token<'a> {
    seller: &'a [u8],
}

/// The token a key names: `None` for a key outside `own/`, and a rejection
/// for a malformed `own/` key.
fn token(key: &[u8]) -> Option<Option<Token<'_>>> {
    let mut segments = key.split(|&byte| byte == b'/');
    if segments.next()? != b"own" {
        return Some(None);
    }
    Some(Some(Token { seller: named(&mut segments)? }))
}

/// `<owner>/<name>` from the remaining segments: a non-empty owner, then at
/// least one segment, none of them empty. Returns the owner.
fn named<'a>(segments: &mut impl Iterator<Item = &'a [u8]>) -> Option<&'a [u8]> {
    let owner = segments.next().filter(|owner| !owner.is_empty())?;
    let mut count = 0;
    for segment in segments {
        if segment.is_empty() {
            return None;
        }
        count += 1;
    }
    (count > 0).then_some(owner)
}
