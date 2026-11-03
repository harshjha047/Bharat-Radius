# Cutover rollback (IMPLEMENTATION_PLAN §8): make BharatRadius the first RADIUS server again, keep the new one as second.
{
:local tag "isp-radius"
:local fb [/radius find where comment~"$tag fallback"]
:if ([:len $fb] = 0) do={ :error "no fallback entry tagged '$tag fallback'" }
/radius move $fb 0
:put "BharatRadius is now first. Kick affected users so they re-authenticate:  /ppp active remove [find]"
}
