// Tables to remove (deduplicated)
const tablesToRemove = new Set([
  'EmployeeHistory', 'CentralProperty', 'BC_DEBUG_AccountServiceUnitConsumptionInfo',
  'BC_DEBUG_AccountServiceUnitNonMeteredInfo', 'CUST_AESImportWork', 'IdahoPERSI',
  'UTAccountServiceMeter_52Build', 'Address_Backup', 'Permit', 'PIFinalizationError',
  'RetireeAddress', 'PAEmployeeAddress', 'PAEmployeeAddressDetail', 'RelatedProfessional',
  'AccountsPayableImportInvoice', 'AddressExportSummary', 'AddressImportDetail',
  'AddressImportDetailError', 'AddressImportSummary', 'AKPERSData', 'Applicant',
  'ApplicantJobHistory', 'BankAccountEmailConfirmationDefaults', 'CaseRequest', 'Cases',
  'CentralServiceAddressMasterMeters', 'CertifiedAddress', 'CheckImportHeader',
  'CobraAdditionalDependents', 'CobraMember', 'CommonNameAddress', 'GrantorContact',
  'GrievanceParties', 'HRAuditEmployee', 'IARetirementData', 'IdahoPERSIHeader',
  'ImprovementsServiceAddress', 'InsuranceCarrier', 'Jurisdiction', 'KYRetirement',
  'LicenseeAnimalBoarding', 'LicenseeAnimalVaccination', 'LicenseeBusinessAddress',
  'LicenseeContact', 'MBCustomerContact', 'MBImportInvoiceHeader', 'MDRetirementFile',
  'MTPera', 'NHERSMember', 'NMPERAHeader', 'OREmployeeInfo', 'ParcelOwnerInfo',
  'ParsedAddresses', 'PermitIssuedToHistory', 'PermitRelatedProfessionals',
  'PermitTypeParcelServiceAddressData', 'PIImportBatch', 'PIParcel', 'PIParcelAddresses',
  'ReissuedTransactionTracking', 'RequestApplicant', 'RequestApplicantJobHistory',
  'RequestContactNew', 'RequestDependent', 'RequestEmployee', 'Retiree',
  'RosterAgencyContact', 'RosterEmployee', 'ThirdPartyReceivable',
  'ThirdPartyReceivablePayments', 'TrainingLocations', 'UTConsumptionMasterMeters',
  'UTMeterImportDetailConsumption', 'UTPaymentAssistanceEnrollDetail',
  'UTPaymentAssistanceUnmatchedHistory', 'UTRefundHeader', 'UTSewerAverageBilling',
  'Vendor1099Import', 'VendorChangeRequestContact', 'FMFormLetterHistory', 'SABill',
  'WorkOrder', 'ImportedApplicantAddress', 'ORSMember', 'WARetirement',
  'YE1094NonEmployer', 'YE1095NonEmployee', 'CentralServiceAddressMeterMalfunctions',
  'ImportNonMeteredUnitStaging', 'InteractiveMeterRead', 'SeasonalAverageMetersToAverage',
  'LEEmployeeContact', 'Person_Address', 'Address', 'GISConfiguration', 'Location',
  'AKRetirementMember', 'IARetirementDetail', 'WARetirementDetail',
  'BC_DEBUG_AccountMeterChangeOutInfo', 'BC_DEBUG_AccountMeterConsumptionInfo',
  'BC_DEBUG_AccountMeterOffPeakDemand', 'BC_DEBUG_AccountRateInformation',
  'BC_DEBUG_AccountServicesToBill', 'BC_DEBUG_CostAdjustmentMeasurements',
  'BC_DEBUG_DeductionMeterConsumptionRateCharges', 'BC_DEBUG_DeductionMeterConsumptionRates',
  'BC_DEBUG_DeterminedMobilityAccounts', 'BC_DEBUG_MeterConsumptionRateCharges',
  'BC_DEBUG_MeterConsumptionRates', 'BC_DEBUG_MeterDemandRateCharges',
  'BC_DEBUG_MeterDemandRates', 'BC_DEBUG_MeterRateSteps',
  'BC_DEBUG_MeterSewerAverageConsumption', 'BC_DEBUG_TransactionsToLink',
  'CP_DEBUG_AccountMeterChangeOutInfo', 'CP_DEBUG_AccountMeterConsumptionInfo',
  'CP_DEBUG_AccountServicesToBill', 'CP_DEBUG_ChangeOuts', 'MA_DEBUG_AverageConsumption',
  'MA_DEBUG_ChangeOutHistory', 'MA_DEBUG_CurrentConsumptions', 'MPERADemoEnrollment',
  'BC_DEBUG_AccountMeterPowerFactorDemand', 'RequestEmployeeAddressChangeModified',
  'UTRetirementDetail', 'FLRetirementDetail', 'CentralServiceMeterRatesMobilityHistory',
  'UtilityTransactionHistoryReportResults', 'ImportedApplicantContact',
  'AKRetirementBrsMember', 'WorkOrders_DeleteLog'
]);

const fs = require('fs');

// Read the JSON from input file
const inputJson = fs.readFileSync('c:\\Users\\ccoble\\AskMeSC\\input_tables.json', 'utf8');
const tables = JSON.parse(inputJson);

// Filter out the tables to remove
const filtered = tables.filter(item => !tablesToRemove.has(item.source.table));

console.log(`Original count: ${tables.length}`);
console.log(`Removed: ${tables.length - filtered.length}`);
console.log(`Remaining: ${filtered.length}`);

// Write the filtered JSON
fs.writeFileSync('c:\\Users\\ccoble\\AskMeSC\\filtered_tables.json', JSON.stringify(filtered, null, 2));
console.log('Filtered JSON written to filtered_tables.json');
