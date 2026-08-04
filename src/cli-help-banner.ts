/** Additive general-help banner for the 0.2 command surface. */
const args = process.argv.slice(2);
const command = args[0];

if (!command || (command === 'help' && !args[1])) {
  process.stdout.write(`New in Mattermark 0.2:\n  preflight  Compare durable and search-safe marking before issuance\n  key        Display the evidence signing-key fingerprint\n  export     Create a signed portable evidence bundle\n  verify     Verify a bundle without opening a Mattermark vault\n\n`);
}
