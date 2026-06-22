/**
 * electron-builder afterPack hook
 *
 * Copies the pre-compiled macOS 26+ Liquid Glass icon (Assets.car) into the
 * app bundle. The Assets.car file is compiled locally using actool with the
 * macOS 26 SDK (not available in CI), then committed to the repo.
 *
 * To regenerate Assets.car after icon changes:
 *   cd apps/electron
 *   xcrun actool "resources/icon.icon" --compile "resources" \
 *     --app-icon AppIcon --minimum-deployment-target 26.0 \
 *     --platform macosx --output-partial-info-plist /dev/null
 *
 * For older macOS versions, the app falls back to icon.icns which is
 * included separately by electron-builder.
 */

const path = require('node:path');
const fs = require('node:fs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const productName = context.packager.appInfo.productName;
  const resourcesDir = path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources');
  const precompiledAssets = path.join(context.packager.projectDir, 'resources', 'Assets.car');

  if (!fs.existsSync(precompiledAssets)) {
    console.log('afterPack: Assets.car not found — app will use AppIcon.icns');
    return;
  }

  fs.copyFileSync(precompiledAssets, path.join(resourcesDir, 'Assets.car'));
  console.log('afterPack: Liquid Glass icon (Assets.car) copied');
};
