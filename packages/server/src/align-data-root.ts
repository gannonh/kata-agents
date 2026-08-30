const dataRoot = process.env.KATA_DATA_ROOT?.trim()
if (dataRoot && !process.env.KATA_CONFIG_DIR?.trim()) {
  process.env.KATA_CONFIG_DIR = dataRoot
}

if (!process.env.KATA_COMPUTER_KIND?.trim()) {
  process.env.KATA_COMPUTER_KIND = 'self-hosted-headless'
}
