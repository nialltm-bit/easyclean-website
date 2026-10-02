/*
 * EasyClean Somerset: where we take online bookings.
 *
 * This list is the ONE place to change the area. The booking pages
 * (index.html and agents.html) use it to check a postcode as it is typed,
 * and the booking system (Apps Script) reads this same file to double-check
 * every booking, so there is nothing to change anywhere else.
 *
 * Each entry is a postcode district: the first half of a postcode
 * (BA3 2EE is in district BA3). To add an area, add its district in quotes
 * with a comma after it. To remove one, delete its line.
 * The website picks up a change within about 10 minutes, the booking
 * system within about an hour.
 *
 * Anyone outside these districts is offered WhatsApp instead of booking online.
 */
window.EC_SERVICE_AREA = [
  // Somerset and BANES
  "BA1",  // Bath
  "BA2",  // Bath (south) and villages
  "BA3",  // Midsomer Norton, Radstock
  "BA4",  // Shepton Mallet
  "BA5",  // Wells
  "BA6",  // Glastonbury
  "BA7",  // Castle Cary
  "BA10", // Bruton
  "BA11", // Frome
  "BA16", // Street
  "BS27", // Cheddar
  "BS28", // Wedmore
  "BS31", // Keynsham, Saltford
  "BS39", // Paulton, Temple Cloud, Clutton, High Littleton
  "BS40", // Chew Valley, Blagdon

  // Bristol: south
  "BS3",  // Bedminster, Southville
  "BS4",  // Knowle, Brislington, Totterdown
  "BS13", // Hartcliffe, Bishopsworth
  "BS14", // Whitchurch, Hengrove, Stockwood
  "BS41", // Long Ashton, Dundry

  // Bristol: central and east
  "BS1",  // City centre
  "BS2",  // St Pauls, Kingsdown
  "BS5",  // Easton, St George
  "BS6",  // Redland, Cotham
  "BS7",  // Bishopston, Horfield
  "BS8",  // Clifton, Hotwells
  "BS15", // Kingswood, Hanham
  "BS16", // Fishponds, Downend
  "BS30"  // Warmley, Longwell Green, Bitton
];

/*
 * Checks a postcode against the list above.
 * Returns { status, outward, formatted } where status is:
 *   "ok"      a full postcode inside the area
 *   "out"     a full postcode outside the area
 *   "invalid" not (yet) a full UK postcode
 *   "empty"   nothing entered
 */
window.ecPostcodeCheck = function (raw) {
  var s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return { status: "empty" };
  var m = s.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/);
  if (!m) return { status: "invalid" };
  var outward = m[1];
  return {
    status: window.EC_SERVICE_AREA.indexOf(outward) > -1 ? "ok" : "out",
    outward: outward,
    formatted: outward + " " + m[2]
  };
};
