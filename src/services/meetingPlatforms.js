// Detect Skribby `service` from join URL (zoom | gmeet | teams).
function detectSkribbyService(meetingUrl) {
  const u = String(meetingUrl || '').toLowerCase();
  if (/zoom\.us\/(j\/|my\/|wc\/)/.test(u) || /zoom\.us\/j\?/.test(u)) return 'zoom';
  if (/meet\.google\.com\//.test(u)) return 'gmeet';
  if (/teams\.microsoft\.com\//.test(u) || /teams\.live\.com\//.test(u)) return 'teams';
  return null;
}

function isSupportedMeetingUrl(meetingUrl) {
  return detectSkribbyService(meetingUrl) != null;
}

module.exports = { detectSkribbyService, isSupportedMeetingUrl };
