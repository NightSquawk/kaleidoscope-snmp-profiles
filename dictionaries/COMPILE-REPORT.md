# Compile report

Generated 2026-09-12 by `pnpm compile` with smidump 0.4.8. Do not edit; rerun the compiler.

## Summary

| | |
|---|---|
| MIB source | `mibs` |
| Vendor directories | 22 |
| Files given to libsmi | 2653 |
| smidump invocations | 53 |
| Modules parsed | 2644 (8 duplicate module names skipped) |
| Objects seen | 265614 |
| Dropped: outside enterprises tree | 43305 |
| Dropped: not readable (not-accessible, accessible-for-notify) | 14928 |
| Dropped: enterprise has no registry row | 28027 across 59 roots |
| Written | 20 dictionaries, 143196 OIDs |
| Textual-convention modules fetched on demand | 63 (0 not found) |
| Objects whose type fell back to string | 156 |
| Files that crashed libsmi | 1 |
| Files on which libsmi hung | 0 |
| Files with runaway output | 0 |
| Wall time | 44s (4 jobs) |

## Dictionaries

| Slug | OIDs | Modules | Source dirs |
|---|---:|---:|---|
| mib-apc-ups | 5894 | 4 | apc, inova |
| mib-aruba-switch | 1962 | 25 | aruba |
| mib-brother-printer | 950 | 1 | brother |
| mib-cisco-switch | 89048 | 1171 | cisco, ciscosb |
| mib-cyberpower-ups | 775 | 1 | cyberpower |
| mib-eaton-ups | 728 | 10 | eaton |
| mib-fortinet-firewall | 1593 | 12 | fortinet |
| mib-hp-generic | 29245 | 532 | hp |
| mib-juniper-switch | 9553 | 142 | juniper |
| mib-lexmark-printer | 341 | 4 | lexmark |
| mib-microsoft-server | 708 | 7 | microsoft |
| mib-net-snmp-server | 51 | 5 | net-snmp |
| mib-novell-server | 521 | 7 | cisco, novell |
| mib-palo-alto-firewall | 313 | 3 | paloalto |
| mib-qnap-nas | 243 | 2 | qnap |
| mib-sonicwall-firewall | 228 | 8 | sonicwall |
| mib-sophos-firewall | 106 | 1 | sophos |
| mib-synology-nas | 254 | 17 | synology |
| mib-ubiquiti-access-point | 406 | 8 | ubiquiti |
| mib-zebra-printer | 277 | 1 | zebra |

## Enterprises with MIBs but no registry row

Add a row to `registry/sysobjectid.yaml` to compile any of these. Top 80 by object count.

| Enterprise root | Readable objects | Modules | Example module |
|---|---:|---:|---|
| 1.3.6.1.4.1.232 | 5234 | 57 | COMPAQ-AGENT-MIB |
| 1.3.6.1.4.1.41916 | 3269 | 16 | VIPTELA-APP-ROUTE |
| 1.3.6.1.4.1.351 | 2799 | 72 | BASIS-GENERIC-MIB |
| 1.3.6.1.4.1.4413 | 2110 | 39 | DVMRP-STD-MIB |
| 1.3.6.1.4.1.14179 | 1121 | 3 | AIRESPACE-SWITCHING-MIB |
| 1.3.6.1.4.1.1918 | 1031 | 2 | RPS-SC200-MIB |
| 1.3.6.1.4.1.1429 | 1015 | 44 | CISCO-DMN-DSG-ABOUT-MIB |
| 1.3.6.1.4.1.11068 | 897 | 1 | DDOSSECURE4-MIB |
| 1.3.6.1.4.1.3076 | 794 | 30 | ADMIN-AUTH-STATS-MIB |
| 1.3.6.1.4.1.9804 | 790 | 18 | LEFTHAND-NETWORKS-NSM-CLUSTERING-MIB |
| 1.3.6.1.4.1.353 | 734 | 7 | ATM-FORUM-ADDR-REG |
| 1.3.6.1.4.1.20677 | 649 | 3 | EATON-EPDU-PU-MI-MIB |
| 1.3.6.1.4.1.63131 | 637 | 1 | PowerNet-Inova |
| 1.3.6.1.4.1.10923 | 621 | 1 | GGSN-MIB |
| 1.3.6.1.4.1.47196 | 608 | 32 | ARUBAWIRED-AAA-MIB |
| 1.3.6.1.4.1.711 | 594 | 1 | LIGHTSTREAM-MIB |
| 1.3.6.1.4.1.3607 | 565 | 10 | CERENT-454-MIB |
| 1.3.6.1.4.1.5528 | 478 | 3 | NETBOTZ-DEVICE-MIB |
| 1.3.6.1.4.1.522 | 476 | 2 | AWC-VLAN-CFG-MIB |
| 1.3.6.1.4.1.437 | 298 | 2 | ES-MODULE-MIB |
| 1.3.6.1.4.1.52674 | 261 | 1 | NetBotz50-MIB |
| 1.3.6.1.4.1.5655 | 235 | 3 | CISCO-SCAS-BB-MIB |
| 1.3.6.1.4.1.15497 | 232 | 2 | ASYNCOS-MAIL-MIB |
| 1.3.6.1.4.1.2021 | 220 | 9 | LM-SENSORS-MIB |
| 1.3.6.1.4.1.705 | 198 | 1 | MG-SNMP-UPS-MIB |
| 1.3.6.1.4.1.37963 | 175 | 5 | AFFIRMED-ALARM-MIB |
| 1.3.6.1.4.1.2947 | 151 | 1 | BESTPOWER-MIB |
| 1.3.6.1.4.1.1570 | 141 | 1 | Cisco90Series-MIB |
| 1.3.6.1.4.1.18997 | 138 | 1 | IBRIX-MIB |
| 1.3.6.1.4.1.224 | 123 | 6 | LANOPTICS-ALERTS-MIB |
| 1.3.6.1.4.1.2544 | 108 | 1 | METRO1500-MIB |
| 1.3.6.1.4.1.2064 | 102 | 1 | SFOS-FIREWALL-OLD-MIB |
| 1.3.6.1.4.1.8239 | 100 | 2 | JUNIPER-WX-COMMON-MIB |
| 1.3.6.1.4.1.494 | 96 | 2 | MADGEBOX-MIB |
| 1.3.6.1.4.1.4491 | 95 | 4 | CLAB-DEF-MIB |
| 1.3.6.1.4.1.36 | 91 | 3 | SVRCLU-MIB |
| 1.3.6.1.4.1.17471 | 79 | 1 | ACTONA-ACTASTOR-MIB |
| 1.3.6.1.4.1.37447 | 79 | 2 | NIMBLE-MIB |
| 1.3.6.1.4.1.119 | 76 | 2 | A100-R1-MIB |
| 1.3.6.1.4.1.43296 | 72 | 1 | EXALINK-FUSION-MIB |
| 1.3.6.1.4.1.77 | 68 | 1 | LanMgr-Mib-II-MIB |
| 1.3.6.1.4.1.1869 | 56 | 1 | ONS15501-MIB |
| 1.3.6.1.4.1.21067 | 54 | 1 | XG-FIREWALL-MIB |
| 1.3.6.1.4.1.29671 | 52 | 1 | MERAKI-CLOUD-CONTROLLER-MIB |
| 1.3.6.1.4.1.55062 | 43 | 1 | QTS-MIB |
| 1.3.6.1.4.1.2699 | 36 | 2 | HP-OFFICEJET-PRO-X576DW-MIB |
| 1.3.6.1.4.1.13742 | 34 | 1 | PDU-MIB |
| 1.3.6.1.4.1.7505 | 29 | 1 | CALISTA-DPA-MIB |
| 1.3.6.1.4.1.2252 | 26 | 1 | NETRANGER |
| 1.3.6.1.4.1.12925 | 25 | 1 | ThreeParMIB |
| 1.3.6.1.4.1.12532 | 22 | 1 | JUNIPER-IVE-MIB |
| 1.3.6.1.4.1.255 | 19 | 1 | COMPAT-MIB |
| 1.3.6.1.4.1.795 | 18 | 1 | HPNSATRAP-MIB |
| 1.3.6.1.4.1.10002 | 15 | 1 | FROGFOOT-RESOURCES-MIB |
| 1.3.6.1.4.1.17373 | 13 | 1 | EATON-GENESIS-II-MIB |
| 1.3.6.1.4.1.16 | 10 | 1 | HPNSATRAP-MIB |
| 1.3.6.1.4.1.7185 | 7 | 1 | CISCO-LATITUDE-MIB |
| 1.3.6.1.4.1.12 | 5 | 1 | TOASTER-MIB |
| 1.3.6.1.4.1.21068 | 3 | 1 | IONLINE-MIB |

## Files that crashed libsmi

smidump exited abnormally on these inputs; they were skipped. Each was isolated by bisection so the rest of the directory still compiled. They are malformed by other parsers too.

- `juniper/EX2500-BASE-MIB`
