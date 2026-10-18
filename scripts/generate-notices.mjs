import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const packageJsonPath = join(root, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

const OFL_1_1 = `SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free
and open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components
as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software
to a new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font Software,
subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font
name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright Holder(s)
or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to remain
under this license does not apply to any document created using the Font
Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.`;

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const ISC = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;

const upstreamLicenseText = {
  fuzzy: `Copyright (c) 2012 Matt York

${MIT}`,
  khroma: `The MIT License (MIT)

Copyright (c) 2019-present Fabio Spampinato, Andrew Maney

${MIT}`,
};

const licenseTextFallback = (license) => {
  const normalized = license.toUpperCase();

  if (normalized.includes('MIT')) {
    return MIT;
  }
  if (normalized.includes('ISC')) {
    return ISC;
  }

  return `This package declares the ${license} license. The package's license text
was not included in its installed package directory; the package metadata and
upstream repository are listed above for the authoritative text.`;
};

const readPackageJson = (packageDirectory) => {
  try {
    return JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
};

const resolvePackageDirectory = (packageName, fromDirectory) => {
  let directory = fromDirectory;

  while (true) {
    const candidate = join(directory, 'node_modules', packageName);
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
};

const packageQueue = Object.keys(packageJson.dependencies ?? {}).map((name) => ({
  name,
  directory: resolvePackageDirectory(name, root),
}));
const packages = new Map();

while (packageQueue.length > 0) {
  const next = packageQueue.shift();
  if (!next?.directory) {
    continue;
  }

  const manifest = readPackageJson(next.directory);
  if (!manifest) {
    continue;
  }

  const key = `${manifest.name}@${manifest.version}`;
  if (packages.has(key)) {
    continue;
  }
  packages.set(key, { manifest, directory: next.directory });

  for (const dependencyName of Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  })) {
    packageQueue.push({
      name: dependencyName,
      directory: resolvePackageDirectory(dependencyName, next.directory),
    });
  }
}

const findLicenseFile = (directory) => {
  const candidates = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'license',
    'license.md',
    'license.txt',
    'LICENCE',
    'LICENCE.md',
    'COPYING',
    'COPYING.md',
    'NOTICE',
    'NOTICE.md',
  ];

  for (const candidate of candidates) {
    const path = join(directory, candidate);
    if (existsSync(path)) {
      return path;
    }
  }

  return undefined;
};

const packageSections = [...packages.values()]
  .sort((first, second) => first.manifest.name.localeCompare(second.manifest.name))
  .map(({ manifest, directory }) => {
    const metadataLicense = typeof manifest.license === 'string'
      ? manifest.license
      : manifest.license?.type ?? manifest.licenses?.[0]?.type;
    const license = metadataLicense
      ?? (manifest.name in upstreamLicenseText ? 'MIT' : 'SEE PACKAGE METADATA');
    const licenseFile = findLicenseFile(directory);
    const licenseText = licenseFile
      ? readFileSync(licenseFile, 'utf8').trim()
      : upstreamLicenseText[manifest.name] ?? licenseTextFallback(license);
    const repository = typeof manifest.repository === 'string'
      ? manifest.repository
      : manifest.repository?.url;
    const location = relative(root, directory).replaceAll('\\', '/');

    return `### ${manifest.name}@${manifest.version}

- License: ${license}
- Package: \`${location}\`${repository ? `\n- Upstream: ${repository}` : ''}

#### License text

${licenseText}`;
  });

const fontNotices = `## Bundled fonts

The Vite build emits the Excalidraw production font assets into \`dist/fonts\`
from the installed package, except Liberation Sans. Liberation Sans is used by
Excalidraw only for server-side export and is excluded because its GPL terms are
not needed by this browser bundle.

### Virgil

Copyright (c) 2011 by Your Own Font Foundry. All rights reserved.
Licensed under the SIL Open Font License, Version 1.1.

### Excalifont

Copyright (c) 2024 by Excalidraw. All rights reserved.
Licensed under the SIL Open Font License, Version 1.1.

### Assistant

Copyright 2020 The Assistant Project Authors.
Copyright 2010 The Source Sans Pro Authors, with Reserved Font Name "Source".
Licensed under the SIL Open Font License, Version 1.1.

### Lilita One

Copyright (c) 2011 Juan Montoreano, with Reserved Font Name "Lilita One".
Licensed under the SIL Open Font License, Version 1.1.

### Nunito

Copyright 2014 The Nunito Project Authors.
Licensed under the SIL Open Font License, Version 1.1.

### Cascadia Code

Copyright 2020 Microsoft Corporation. All Rights Reserved.
Licensed under the SIL Open Font License, Version 1.1.

### Xiaolai SC

Copyright (c) 2020 LXGW.
Licensed under the SIL Open Font License, Version 1.1.

### Comic Shanns

Copyright (c) 2018 Shannon Miwa
Copyright (c) 2023 Jesus Gonzalez
Copyright (c) 2023 Rodrigo Batista de Moraes
Copyright (c) 2024 Fini Jastrow
Copyright (c) 2024 Kyle Beechly

${MIT}`;

const output = `# Drawit third-party notices

Generated by \`npm run notices\`. The package list follows the production
dependency graph from \`package.json\`; development-only tooling is omitted.

## Excalidraw

Copyright (c) 2020 Excalidraw

${MIT}

## Production dependency licenses

${packageSections.join('\n\n')}

${fontNotices}

## SIL Open Font License 1.1

${OFL_1_1}
`;

const normalized = output.replaceAll('\r\n', '\n');
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), normalized, 'utf8');

console.log(`Generated notices for ${packages.size} production packages and 8 font families.`);
