export const LIVE_MAILBOX_ACCESS_SQL = `EXISTS (
	SELECT 1
	FROM users AS owner
	JOIN mailboxes AS mailbox ON mailbox.id = ?
	WHERE owner.id = ?
	  AND owner.is_active = 1
	  AND mailbox.is_active = 1
	  AND (
	    (mailbox.type = 'PERSONAL' AND mailbox.owner_user_id = owner.id)
	    OR (
	      mailbox.type = 'SHARED'
	      AND EXISTS (
	        SELECT 1 FROM mailbox_memberships AS membership
	        WHERE membership.mailbox_id = mailbox.id
	          AND membership.user_id = owner.id
	      )
	    )
	  )
)`;
