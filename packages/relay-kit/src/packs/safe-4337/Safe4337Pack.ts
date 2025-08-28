import { getAddress, toHex } from 'viem'
import semverSatisfies from 'semver/functions/satisfies.js'
import Safe, {
  EthSafeSignature,
  encodeMultiSendData,
  getMultiSendContract,
  PasskeyClient,
  SafeProvider,
  generateOnChainIdentifier,
  SafeAccountConfig
} from '@safe-global/protocol-kit'
import { RelayKitBasePack } from '@safe-global/relay-kit/RelayKitBasePack'
import {
  OperationType,
  SafeOperationConfirmation,
  SafeOperationResponse,
  SafeSignature,
  SigningMethod
} from '@safe-global/types-kit'
import {
  getSafeModuleSetupDeployment,
  getSafe4337ModuleDeployment,
  getSafeWebAuthnShareSignerDeployment
} from '@safe-global/safe-modules-deployments'
import {
  getSafeSingletonDeployment,
  getProxyFactoryDeployment
} from '@safe-global/safe-deployments'
import { Hash, encodeFunctionData, zeroAddress, Hex, concat, keccak256, slice } from 'viem'
import BaseSafeOperation from '@safe-global/relay-kit/packs/safe-4337/BaseSafeOperation'
import SafeOperationFactory from '@safe-global/relay-kit/packs/safe-4337/SafeOperationFactory'
import {
  EstimateFeeProps,
  Safe4337CreateTransactionProps,
  Safe4337ExecutableProps,
  Safe4337InitOptions,
  Safe4337Options,
  UserOperationReceipt,
  UserOperationWithPayload,
  PaymasterOptions,
  BundlerClient
} from '@safe-global/relay-kit/packs/safe-4337/types'
import {
  ABI,
  DEFAULT_SAFE_VERSION,
  DEFAULT_SAFE_MODULES_VERSION,
  RPC_4337_CALLS
} from '@safe-global/relay-kit/packs/safe-4337/constants'
import {
  entryPointToSafeModules,
  getDummySignature,
  createBundlerClient,
  userOperationToHexValues,
  getRelayKitVersion,
  createUserOperation
} from '@safe-global/relay-kit/packs/safe-4337/utils'
import { PimlicoFeeEstimator } from '@safe-global/relay-kit/packs/safe-4337/estimators/pimlico/PimlicoFeeEstimator'
import { SafeVersion } from '@safe-global/types-kit'

/**
 * Gets the Safe contract addresses for a given chain ID and Safe version.
 * Uses the @safe-global/safe-deployments package to dynamically fetch addresses.
 *
 * @param {bigint | number} chainId - The chain ID.
 * @param {string} [safeVersion='1.4.1'] - The Safe version to resolve addresses for.
 * @returns {{ factory: string; singleton: string }} Object containing factory and singleton addresses.
 * @throws {Error} If no addresses are found for the chain ID and version.
 */
function getSafeContractAddresses(
  chainId: bigint | number,
  safeVersion: string = '1.4.1'
): { factory: string; singleton: string } {
  const chainIdStr = chainId.toString()

  const singletonDeployment = getSafeSingletonDeployment({
    version: safeVersion as SafeVersion,
    released: true
  })

  if (!singletonDeployment) {
    throw new Error(`No Safe singleton deployment found for version ${safeVersion}`)
  }

  // Get factory deployment for the specified version
  const factoryDeployment = getProxyFactoryDeployment({
    version: safeVersion as SafeVersion,
    released: true
  })

  if (!factoryDeployment) {
    throw new Error(`No Safe proxy factory deployment found for version ${safeVersion}`)
  }

  const singletonAddress = singletonDeployment.networkAddresses[chainIdStr]
  const factoryAddress = factoryDeployment.networkAddresses[chainIdStr]

  if (!singletonAddress) {
    throw new Error(
      `No Safe singleton address found for chain ID ${chainId} and version ${safeVersion}`
    )
  }

  if (!factoryAddress) {
    throw new Error(
      `No Safe proxy factory address found for chain ID ${chainId} and version ${safeVersion}`
    )
  }

  return {
    factory: factoryAddress,
    singleton: singletonAddress
  }
}

// Proxy creation codes for different Safe versions
const SAFE_PROXY_CREATION_CODES = {
  // Early versions (1.0.0 - 1.2.0) use the older proxy creation code
  legacy:
    '0x608060405234801561001057600080fd5b506040516020806101a88339810180604052602081101561003057600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100c7576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260248152602001806101846024913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050606e806101166000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054163660008037600080366000845af43d6000803e6000811415603d573d6000fd5b3d6000f3fea165627a7a723058201e7d648b83cfac072cbccefc2ffc62a6999d4a050ee87a721942de1da9670db80029496e76616c6964206d617374657220636f707920616464726573732070726f7669646564',
  // Newer versions (1.3.0+) use the updated proxy creation code
  latest:
    '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564'
} as const

/**
 * Detects if a chain is zkSync.
 *
 * @param {bigint | number} chainId - The chain ID to check.
 * @returns {boolean} True if the provided chain is a zkSync network; otherwise false.
 */
function isZkSyncChain(chainId: bigint | number): boolean {
  const ZKSYNC_CHAIN_IDS = new Set([
    324, // zkSync Era mainnet
    300, // zkSync Era testnet
    280, // zkSync Era localnet
    232 // zkSync Era internal testnet
  ])
  return ZKSYNC_CHAIN_IDS.has(Number(chainId))
}

/**
 * Returns the Safe Proxy creation bytecode for the provided Safe version on EVM chains.
 *
 * - Versions 1.0.0 - 1.2.0 use the legacy bytecode.
 * - Versions 1.3.0+ use the latest bytecode.
 * - zkSync chains are not supported by this function (different CREATE2 mechanics).
 *
 * @param {string} safeVersion - The Safe core version used to select the bytecode.
 * @param {bigint | number} [chainId] - Optional chain ID; if a zkSync chain is detected, an error is thrown.
 * @returns {`0x${string}`} The proxy creation bytecode for the given Safe version.
 * @throws {Error} If called for a zkSync chain.
 */
function getProxyCreationCode(safeVersion: string, chainId?: bigint | number): `0x${string}` {
  if (chainId && isZkSyncChain(chainId)) {
    // TODO: implement zkSync
    throw new Error(
      `zkSync chains (${chainId}) use different CREATE2 mechanics. Use predictSafeAddressWithChainId for zkSync support.`
    )
  }

  const version = safeVersion.split('.')
  const major = parseInt(version[0])
  const minor = parseInt(version[1])

  if (major === 1 && minor <= 2) {
    return SAFE_PROXY_CREATION_CODES.legacy
  } else {
    return SAFE_PROXY_CREATION_CODES.latest
  }
}

// Constants for Safe deployment
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const EMPTY_DATA = '0x'

const MAX_ERC20_AMOUNT_TO_APPROVE =
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn

const EQ_OR_GT_1_4_1 = '>=1.4.1'

/**
 * Encodes the Safe setup initializer data synchronously.
 *
 * Produces the exact calldata used by Safe deployment, matching version-specific ABIs:
 * - Safe 1.0.0: setup(address[] _owners, uint256 _threshold, address to, bytes data, address paymentToken, uint256 payment, address paymentReceiver)
 * - Safe 1.1.0+: setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)
 *
 * @param {SafeAccountConfig} safeAccountConfig - The configuration used for the Safe setup transaction.
 * @param {string} safeVersion - The Safe core version used to select the correct ABI.
 * @returns {string} Hex-encoded calldata for the Safe setup function.
 */
function encodeSetupCallDataSync(
  safeAccountConfig: SafeAccountConfig,
  safeVersion: string
): string {
  const {
    owners,
    threshold,
    to = ZERO_ADDRESS,
    data = EMPTY_DATA,
    fallbackHandler = ZERO_ADDRESS,
    paymentToken = ZERO_ADDRESS,
    payment = 0,
    paymentReceiver = ZERO_ADDRESS
  } = safeAccountConfig

  const version = safeVersion.split('.')
  const major = parseInt(version[0])
  const minor = parseInt(version[1])

  if (major === 1 && minor === 0) {
    // Safe 1.0.0 and below: 7 parameters (no fallbackHandler)
    const setupData = encodeFunctionData({
      abi: [
        {
          inputs: [
            { name: '_owners', type: 'address[]' },
            { name: '_threshold', type: 'uint256' },
            { name: 'to', type: 'address' },
            { name: 'data', type: 'bytes' },
            { name: 'paymentToken', type: 'address' },
            { name: 'payment', type: 'uint256' },
            { name: 'paymentReceiver', type: 'address' }
          ],
          name: 'setup',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function'
        }
      ],
      functionName: 'setup',
      args: [
        owners,
        BigInt(threshold),
        to as `0x${string}`,
        data as `0x${string}`,
        paymentToken as `0x${string}`,
        BigInt(payment),
        paymentReceiver as `0x${string}`
      ]
    })
    return setupData
  } else {
    // Safe 1.1.0+: 8 parameters (with fallbackHandler)
    const setupData = encodeFunctionData({
      abi: [
        {
          inputs: [
            { name: '_owners', type: 'address[]' },
            { name: '_threshold', type: 'uint256' },
            { name: 'to', type: 'address' },
            { name: 'data', type: 'bytes' },
            { name: 'fallbackHandler', type: 'address' },
            { name: 'paymentToken', type: 'address' },
            { name: 'payment', type: 'uint256' },
            { name: 'paymentReceiver', type: 'address' }
          ],
          name: 'setup',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function'
        }
      ],
      functionName: 'setup',
      args: [
        owners,
        BigInt(threshold),
        to as `0x${string}`,
        data as `0x${string}`,
        fallbackHandler as `0x${string}`,
        paymentToken as `0x${string}`,
        BigInt(payment),
        paymentReceiver as `0x${string}`
      ]
    })
    return setupData
  }
}

/**
 * Safe4337Pack class that extends RelayKitBasePack.
 * This class provides an implementation of the ERC-4337 that enables Safe accounts to wrk with UserOperations.
 * It allows to create, sign and execute transactions using the Safe 4337 Module.
 *
 * @class
 * @link https://github.com/safe-global/safe-modules/blob/main/modules/4337/contracts/Safe4337Module.sol
 * @link https://eips.ethereum.org/EIPS/eip-4337
 */
export class Safe4337Pack extends RelayKitBasePack<{
  EstimateFeeProps: EstimateFeeProps
  EstimateFeeResult: BaseSafeOperation
  CreateTransactionProps: Safe4337CreateTransactionProps
  CreateTransactionResult: BaseSafeOperation
  ExecuteTransactionProps: Safe4337ExecutableProps
  ExecuteTransactionResult: string
}> {
  #BUNDLER_URL: string

  #ENTRYPOINT_ADDRESS: string
  #SAFE_4337_MODULE_ADDRESS: string = '0x'
  #SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS: string = '0x'

  #bundlerClient: BundlerClient

  #chainId: bigint

  #paymasterOptions?: PaymasterOptions

  #onchainIdentifier: string = ''

  /**
   * Creates an instance of the Safe4337Pack.
   *
   * @param {Safe4337Options} options - The initialization parameters.
   */
  constructor({
    protocolKit,
    bundlerClient,
    bundlerUrl,
    chainId,
    paymasterOptions,
    entryPointAddress,
    safe4337ModuleAddress,
    safeWebAuthnSharedSignerAddress,
    onchainAnalytics
  }: Safe4337Options) {
    super(protocolKit)

    this.#BUNDLER_URL = bundlerUrl
    this.#bundlerClient = bundlerClient
    this.#chainId = chainId
    this.#paymasterOptions = paymasterOptions
    this.#ENTRYPOINT_ADDRESS = entryPointAddress
    this.#SAFE_4337_MODULE_ADDRESS = safe4337ModuleAddress
    this.#SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS = safeWebAuthnSharedSignerAddress || '0x'

    if (onchainAnalytics?.project) {
      const { project, platform } = onchainAnalytics
      this.#onchainIdentifier = generateOnChainIdentifier({
        project,
        platform,
        tool: 'relay-kit',
        toolVersion: getRelayKitVersion()
      })
    }
  }

  /**
   * Initializes a Safe4337Pack class.
   * This method creates the protocolKit instance based on the input parameters.
   * When the Safe address is provided, it will use the existing Safe.
   * When the Safe address is not provided, it will use the predictedSafe feature with the provided owners and threshold.
   * It will use the correct contract addresses for the fallbackHandler and the module and will add the data to enable the 4337 module.
   *
   * @param {Safe4337InitOptions} initOptions - The initialization parameters.
   * @return {Promise<Safe4337Pack>} The Promise object that will be resolved into an instance of Safe4337Pack.
   */
  static async init(initOptions: Safe4337InitOptions): Promise<Safe4337Pack> {
    const {
      provider,
      signer,
      options,
      bundlerUrl,
      customContracts,
      paymasterOptions,
      onchainAnalytics
    } = initOptions

    let protocolKit: Safe
    const bundlerClient = createBundlerClient(bundlerUrl)
    const chainId = await bundlerClient.request({ method: RPC_4337_CALLS.CHAIN_ID })

    let safeModulesSetupAddress = customContracts?.safeModulesSetupAddress
    const network = parseInt(chainId, 16).toString()

    const safeModulesVersion = initOptions.safeModulesVersion || DEFAULT_SAFE_MODULES_VERSION

    if (!safeModulesSetupAddress) {
      const safeModuleSetupDeployment = getSafeModuleSetupDeployment({
        released: true,
        version: safeModulesVersion,
        network
      })
      safeModulesSetupAddress = safeModuleSetupDeployment?.networkAddresses[network]
    }

    let safe4337ModuleAddress = customContracts?.safe4337ModuleAddress
    if (!safe4337ModuleAddress) {
      const safe4337ModuleDeployment = getSafe4337ModuleDeployment({
        released: true,
        version: safeModulesVersion,
        network
      })
      safe4337ModuleAddress = safe4337ModuleDeployment?.networkAddresses[network]
    }

    if (!safeModulesSetupAddress || !safe4337ModuleAddress) {
      throw new Error(
        `Safe4337Module and/or SafeModuleSetup not available for chain ${network} and modules version ${safeModulesVersion}`
      )
    }

    let safeWebAuthnSharedSignerAddress = customContracts?.safeWebAuthnSharedSignerAddress

    // Existing Safe
    if ('safeAddress' in options) {
      protocolKit = await Safe.init({
        provider,
        signer,
        safeAddress: options.safeAddress
      })

      const safeVersion = protocolKit.getContractVersion()
      const isSafeVersion4337Compatible = semverSatisfies(safeVersion, EQ_OR_GT_1_4_1)

      if (!isSafeVersion4337Compatible) {
        throw new Error(
          `Incompatibility detected: The current Safe Account version (${safeVersion}) is not supported. EIP-4337 requires the Safe to use at least v1.4.1.`
        )
      }

      const safeModules = (await protocolKit.getModules()) as string[]
      const is4337ModulePresent = safeModules.some((module) => module === safe4337ModuleAddress)

      if (!is4337ModulePresent) {
        throw new Error(
          `Incompatibility detected: The EIP-4337 module is not enabled in the provided Safe Account. Enable this module (address: ${safe4337ModuleAddress}) to add compatibility.`
        )
      }

      const safeFallbackhandler = await protocolKit.getFallbackHandler()
      const is4337FallbackhandlerPresent = safeFallbackhandler === safe4337ModuleAddress

      if (!is4337FallbackhandlerPresent) {
        throw new Error(
          `Incompatibility detected: The EIP-4337 fallbackhandler is not attached to the Safe Account. Attach this fallbackhandler (address: ${safe4337ModuleAddress}) to ensure compatibility.`
        )
      }
    } else {
      // New Safe will be created based on the provided configuration when bundling a new UserOperation
      if (!options.owners || !options.threshold) {
        throw new Error('Owners and threshold are required to deploy a new Safe')
      }

      const safeVersion = options.safeVersion || DEFAULT_SAFE_VERSION

      // we need to create a batch to setup the 4337 Safe Account

      // first setup transaction: Enable 4337 module
      const enable4337ModuleTransaction = {
        to: safeModulesSetupAddress,
        value: '0',
        data: encodeFunctionData({
          abi: ABI,
          functionName: 'enableModules',
          args: [[safe4337ModuleAddress]]
        }),
        operation: OperationType.DelegateCall // DelegateCall required for enabling the 4337 module
      }

      const setupTransactions = [enable4337ModuleTransaction]

      const isApproveTransactionRequired =
        !!paymasterOptions &&
        !paymasterOptions.isSponsored &&
        !!paymasterOptions.paymasterTokenAddress

      if (isApproveTransactionRequired) {
        const { paymasterAddress, amountToApprove = MAX_ERC20_AMOUNT_TO_APPROVE } = paymasterOptions

        // second transaction: approve ERC-20 paymaster token
        const approveToPaymasterTransaction = {
          to: paymasterOptions.paymasterTokenAddress,
          data: encodeFunctionData({
            abi: ABI,
            functionName: 'approve',
            args: [paymasterAddress, amountToApprove]
          }),
          value: '0',
          operation: OperationType.Call // Call for approve
        }

        setupTransactions.push(approveToPaymasterTransaction)
      }

      const safeProvider = await SafeProvider.init({ provider, signer, safeVersion })

      // third transaction: passkey support via shared signer SafeWebAuthnSharedSigner
      // see: https://github.com/safe-global/safe-modules/blob/main/modules/passkey/contracts/4337/experimental/README.md
      const isPasskeySigner = await safeProvider.isPasskeySigner()

      if (isPasskeySigner) {
        if (!safeWebAuthnSharedSignerAddress) {
          const safeWebAuthnSharedSignerDeployment = getSafeWebAuthnShareSignerDeployment({
            released: true,
            version: '0.2.1',
            network
          })
          safeWebAuthnSharedSignerAddress =
            safeWebAuthnSharedSignerDeployment?.networkAddresses[network]
        }

        if (!safeWebAuthnSharedSignerAddress) {
          throw new Error(`safeWebAuthnSharedSignerAddress not available for chain ${network}`)
        }

        const passkeySigner = (await safeProvider.getExternalSigner()) as PasskeyClient

        const checkSummedOwners = options.owners.map((owner) => getAddress(owner))
        const checkSummedSignerAddress = getAddress(safeWebAuthnSharedSignerAddress)

        if (!checkSummedOwners.includes(checkSummedSignerAddress)) {
          options.owners.push(checkSummedSignerAddress)
        }

        const sharedSignerTransaction = {
          to: safeWebAuthnSharedSignerAddress,
          value: '0',
          data: passkeySigner.encodeConfigure(),
          operation: OperationType.DelegateCall // DelegateCall required into the SafeWebAuthnSharedSigner instance in order for it to set its configuration.
        }

        setupTransactions.push(sharedSignerTransaction)
      }

      let deploymentTo
      let deploymentData

      const isBatch = setupTransactions.length > 1

      if (isBatch) {
        const multiSendContract = await getMultiSendContract({
          safeProvider,
          safeVersion,
          deploymentType: options.deploymentType || undefined
        })

        const batchData = encodeFunctionData({
          abi: ABI,
          functionName: 'multiSend',
          args: [encodeMultiSendData(setupTransactions) as Hex]
        })

        deploymentTo = multiSendContract.getAddress()
        deploymentData = batchData
      } else {
        deploymentTo = enable4337ModuleTransaction.to
        deploymentData = enable4337ModuleTransaction.data
      }

      protocolKit = await Safe.init({
        provider,
        signer,
        predictedSafe: {
          safeDeploymentConfig: {
            safeVersion,
            saltNonce: options.saltNonce || undefined,
            deploymentType: options.deploymentType || undefined
          },
          safeAccountConfig: {
            owners: options.owners,
            threshold: options.threshold,
            to: deploymentTo,
            data: deploymentData,
            fallbackHandler: safe4337ModuleAddress,
            paymentToken: zeroAddress,
            payment: 0,
            paymentReceiver: zeroAddress
          }
        },
        onchainAnalytics
      })
    }

    let selectedEntryPoint

    if (customContracts?.entryPointAddress) {
      const requiredSafeModulesVersion = entryPointToSafeModules(customContracts?.entryPointAddress)
      if (!semverSatisfies(safeModulesVersion, requiredSafeModulesVersion))
        throw new Error(
          `The selected entrypoint ${customContracts?.entryPointAddress} is not compatible with version ${safeModulesVersion} of Safe modules`
        )

      selectedEntryPoint = customContracts?.entryPointAddress
    } else {
      const supportedEntryPoints = await bundlerClient.request({
        method: RPC_4337_CALLS.SUPPORTED_ENTRY_POINTS
      })

      if (!supportedEntryPoints.length) {
        throw new Error('No entrypoint provided or available through the bundler')
      }

      selectedEntryPoint = supportedEntryPoints.find((entryPoint: string) => {
        const requiredSafeModulesVersion = entryPointToSafeModules(entryPoint)
        return semverSatisfies(safeModulesVersion, requiredSafeModulesVersion)
      })

      if (!selectedEntryPoint) {
        throw new Error(
          `Incompatibility detected: None of the entrypoints provided by the bundler is compatible with the Safe modules version ${safeModulesVersion}`
        )
      }
    }

    return new Safe4337Pack({
      chainId: BigInt(chainId),
      protocolKit,
      bundlerClient,
      paymasterOptions,
      bundlerUrl,
      entryPointAddress: selectedEntryPoint!,
      safe4337ModuleAddress,
      safeWebAuthnSharedSignerAddress,
      onchainAnalytics
    })
  }

  /**
   * Estimates gas for the SafeOperation.
   *
   * @param {EstimateFeeProps} props - The parameters for the gas estimation.
   * @param {BaseSafeOperation} props.safeOperation - The SafeOperation to estimate the gas.
   * @param {IFeeEstimator} props.feeEstimator - The function to estimate the gas.
   * @return {Promise<BaseSafeOperation>} The Promise object that will be resolved into the gas estimation.
   */

  async getEstimateFee({
    safeOperation,
    feeEstimator = new PimlicoFeeEstimator()
  }: EstimateFeeProps): Promise<BaseSafeOperation> {
    const threshold = await this.protocolKit.getThreshold()
    const preEstimationData = await feeEstimator?.preEstimateUserOperationGas?.({
      bundlerUrl: this.#BUNDLER_URL,
      entryPoint: this.#ENTRYPOINT_ADDRESS,
      userOperation: safeOperation.getUserOperation(),
      paymasterOptions: this.#paymasterOptions
    })

    if (preEstimationData) {
      safeOperation.addEstimations(preEstimationData)
    }

    const estimateUserOperationGas = await this.#bundlerClient.request({
      method: RPC_4337_CALLS.ESTIMATE_USER_OPERATION_GAS,
      params: [
        {
          ...userOperationToHexValues(safeOperation.getUserOperation(), this.#ENTRYPOINT_ADDRESS),
          signature: getDummySignature(this.#SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS, threshold)
        },
        this.#ENTRYPOINT_ADDRESS
      ]
    })

    if (estimateUserOperationGas) {
      safeOperation.addEstimations(estimateUserOperationGas)
    }

    const postEstimationData = await feeEstimator?.postEstimateUserOperationGas?.({
      bundlerUrl: this.#BUNDLER_URL,
      entryPoint: this.#ENTRYPOINT_ADDRESS,
      userOperation: {
        ...safeOperation.getUserOperation(),
        signature: getDummySignature(this.#SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS, threshold)
      },
      paymasterOptions: this.#paymasterOptions
    })

    if (postEstimationData) {
      safeOperation.addEstimations(postEstimationData)
    }

    return safeOperation
  }

  /**
   * Creates a relayed transaction based on the provided parameters.
   *
   * @param {MetaTransactionData[]} transactions - The transactions to batch in a SafeOperation.
   * @param options - Optional configuration options for the transaction creation.
   * @return {Promise<BaseSafeOperation>} The Promise object will resolve a SafeOperation.
   */
  async createTransaction({
    transactions,
    options = {}
  }: Safe4337CreateTransactionProps): Promise<BaseSafeOperation> {
    const { amountToApprove, validUntil, validAfter, feeEstimator, customNonce } = options

    const userOperation = await createUserOperation(this.protocolKit, transactions, {
      entryPoint: this.#ENTRYPOINT_ADDRESS,
      paymasterOptions: this.#paymasterOptions,
      amountToApprove,
      customNonce
    })

    if (this.#onchainIdentifier) {
      userOperation.callData += this.#onchainIdentifier
    }

    const safeOperation = SafeOperationFactory.createSafeOperation(userOperation, {
      chainId: this.#chainId,
      moduleAddress: this.#SAFE_4337_MODULE_ADDRESS,
      entryPoint: this.#ENTRYPOINT_ADDRESS,
      validUntil,
      validAfter
    })

    return await this.getEstimateFee({
      safeOperation,
      feeEstimator
    })
  }

  /**
   * Converts a SafeOperationResponse to an SafeOperation.
   *
   * @param {SafeOperationResponse} safeOperationResponse - The SafeOperationResponse to convert to SafeOperation
   * @returns {BaseSafeOperation} - The SafeOperation object
   */
  #toSafeOperation(safeOperationResponse: SafeOperationResponse): BaseSafeOperation {
    const { validUntil, validAfter, userOperation } = safeOperationResponse

    const paymaster = (userOperation?.paymaster as Hex) || '0x'
    const paymasterData = (userOperation?.paymasterData as Hex) || '0x'
    const safeOperation = SafeOperationFactory.createSafeOperation(
      {
        sender: userOperation?.sender || '0x',
        nonce: userOperation?.nonce || '0',
        initCode: userOperation?.initCode || '',
        callData: userOperation?.callData || '',
        callGasLimit: BigInt(userOperation?.callGasLimit || 0n),
        verificationGasLimit: BigInt(userOperation?.verificationGasLimit || 0),
        preVerificationGas: BigInt(userOperation?.preVerificationGas || 0),
        maxFeePerGas: BigInt(userOperation?.maxFeePerGas || 0),
        maxPriorityFeePerGas: BigInt(userOperation?.maxPriorityFeePerGas || 0),
        paymasterAndData: concat([paymaster, paymasterData]),
        signature: safeOperationResponse.preparedSignature || '0x'
      },
      {
        chainId: this.#chainId,
        moduleAddress: this.#SAFE_4337_MODULE_ADDRESS,
        entryPoint: userOperation?.entryPoint || this.#ENTRYPOINT_ADDRESS,
        validAfter: this.#timestamp(validAfter),
        validUntil: this.#timestamp(validUntil)
      }
    )

    if (safeOperationResponse.confirmations) {
      safeOperationResponse.confirmations.forEach((confirmation: SafeOperationConfirmation) => {
        safeOperation.addSignature(new EthSafeSignature(confirmation.owner, confirmation.signature))
      })
    }

    return safeOperation
  }

  /**
   *
   * @param date An ISO string date
   * @returns The timestamp in seconds to send to the bundler
   */
  #timestamp(date: string | null) {
    return date ? new Date(date).getTime() / 1000 : undefined
  }

  /**
   * Signs a safe operation.
   *
   * @param {BaseSafeOperation | SafeOperationResponse} safeOperation - The SafeOperation to sign. It can be:
   * - A response from the API (Tx Service)
   * - An instance of SafeOperation
   * @param {SigningMethod} signingMethod - The signing method to use.
   * @return {Promise<BaseSafeOperation>} The Promise object will resolve to the signed SafeOperation.
   */
  async signSafeOperation(
    safeOperation: BaseSafeOperation | SafeOperationResponse,
    signingMethod: SigningMethod = SigningMethod.ETH_SIGN_TYPED_DATA_V4
  ): Promise<BaseSafeOperation> {
    let safeOp: BaseSafeOperation

    if (safeOperation instanceof BaseSafeOperation) {
      safeOp = safeOperation
    } else {
      safeOp = this.#toSafeOperation(safeOperation)
    }

    const safeProvider = this.protocolKit.getSafeProvider()
    const signerAddress = await safeProvider.getSignerAddress()
    const isPasskeySigner = await safeProvider.isPasskeySigner()

    if (!signerAddress) {
      throw new Error('There is no signer address available to sign the SafeOperation')
    }

    const isOwner = await this.protocolKit.isOwner(signerAddress)
    const isSafeDeployed = await this.protocolKit.isSafeDeployed()

    if ((!isOwner && isSafeDeployed) || (!isSafeDeployed && !isPasskeySigner && !isOwner)) {
      throw new Error('UserOperations can only be signed by Safe owners')
    }

    let safeSignature: SafeSignature

    if (isPasskeySigner) {
      const safeOpHash = safeOp.getHash()

      if (!isSafeDeployed) {
        const passkeySignature = await this.protocolKit.signHash(safeOpHash)
        safeSignature = new EthSafeSignature(
          this.#SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS,
          passkeySignature.data,
          true
        )
      } else {
        safeSignature = await this.protocolKit.signHash(safeOpHash)
      }
    } else {
      if (
        [
          SigningMethod.ETH_SIGN_TYPED_DATA_V4,
          SigningMethod.ETH_SIGN_TYPED_DATA_V3,
          SigningMethod.ETH_SIGN_TYPED_DATA
        ].includes(signingMethod)
      ) {
        const signer = await safeProvider.getExternalSigner()

        if (!signer) {
          throw new Error('No signer found')
        }

        const signerAddress = signer.account.address
        const safeOperation = safeOp.getSafeOperation()
        const signature = await signer.signTypedData({
          domain: {
            chainId: Number(this.#chainId),
            verifyingContract: this.#SAFE_4337_MODULE_ADDRESS
          },
          types: safeOp.getEIP712Type(),
          message: {
            ...safeOperation,
            nonce: BigInt(safeOperation.nonce),
            validAfter: toHex(safeOperation.validAfter),
            validUntil: toHex(safeOperation.validUntil),
            maxFeePerGas: toHex(safeOperation.maxFeePerGas),
            maxPriorityFeePerGas: toHex(safeOperation.maxPriorityFeePerGas)
          },
          primaryType: 'SafeOp'
        })

        safeSignature = new EthSafeSignature(signerAddress, signature)
      } else {
        const safeOpHash = safeOp.getHash()

        safeSignature = await this.protocolKit.signHash(safeOpHash)
      }
    }

    safeOp.addSignature(safeSignature)

    return safeOp
  }

  /**
   * Executes the relay transaction.
   *
   * @param {Safe4337ExecutableProps} props - The parameters for the transaction execution.
   * @param {BaseSafeOperation | SafeOperationResponse} props.executable - The SafeOperation to execute. It can be:
   * - A response from the API (Tx Service)
   * - An instance of SafeOperation
   * @return {Promise<string>} The user operation hash.
   */
  async executeTransaction({ executable }: Safe4337ExecutableProps): Promise<string> {
    let safeOperation: BaseSafeOperation

    if (executable instanceof BaseSafeOperation) {
      safeOperation = executable
    } else {
      safeOperation = this.#toSafeOperation(executable)
    }

    return this.#bundlerClient.request({
      method: RPC_4337_CALLS.SEND_USER_OPERATION,
      params: [
        userOperationToHexValues(safeOperation.getUserOperation(), this.#ENTRYPOINT_ADDRESS),
        this.#ENTRYPOINT_ADDRESS
      ]
    })
  }

  /**
   * Return a UserOperation based on a hash (userOpHash) returned by eth_sendUserOperation
   *
   * @param {string} userOpHash - The hash of the user operation to fetch. Returned from the #sendUserOperation method
   * @returns {UserOperation} - null in case the UserOperation is not yet included in a block, or a full UserOperation, with the addition of entryPoint, blockNumber, blockHash and transactionHash
   */
  async getUserOperationByHash(userOpHash: string): Promise<UserOperationWithPayload> {
    return this.#bundlerClient.request({
      method: RPC_4337_CALLS.GET_USER_OPERATION_BY_HASH,
      params: [userOpHash as Hash]
    })
  }

  /**
   * Return a UserOperation receipt based on a hash (userOpHash) returned by eth_sendUserOperation
   *
   * @param {string} userOpHash - The hash of the user operation to fetch. Returned from the #sendUserOperation method
   * @returns {UserOperationReceipt} - null in case the UserOperation is not yet included in a block, or UserOperationReceipt object
   */
  async getUserOperationReceipt(userOpHash: string): Promise<UserOperationReceipt | null> {
    return this.#bundlerClient.request({
      method: RPC_4337_CALLS.GET_USER_OPERATION_RECEIPT,
      params: [userOpHash as Hash]
    })
  }

  /**
   * Returns an array of the entryPoint addresses supported by the client.
   * The first element of the array SHOULD be the entryPoint addressed preferred by the client.
   *
   * @returns {string[]} - The supported entry points.
   */
  async getSupportedEntryPoints(): Promise<string[]> {
    return this.#bundlerClient.request({
      method: RPC_4337_CALLS.SUPPORTED_ENTRY_POINTS
    })
  }

  /**
   * Returns EIP-155 Chain ID.
   *
   * @returns {string} - The chain id.
   */
  async getChainId(): Promise<string> {
    return this.#bundlerClient.request({ method: RPC_4337_CALLS.CHAIN_ID })
  }

  getOnchainIdentifier(): string {
    return this.#onchainIdentifier
  }

  /**
   * Predicts the address of a Safe account and returns it.
   *
   * Implements the CREATE2 derivation using the Safe Proxy Factory:
   * address = keccak256(0xff ++ factoryAddress ++ salt ++ keccak256(initCode))[12:]
   *
   * @param {Object} config - The prediction configuration.
   * @param {string} config.factoryAddress - The Safe ProxyFactory contract address.
   * @param {string} config.singletonAddress - The Safe singleton contract address.
   * @param {SafeAccountConfig} config.safeAccountConfig - The Safe account configuration used to encode the initializer.
   * @param {string} config.saltNonce - 0x-prefixed 32-byte salt used for CREATE2.
   * @param {string} config.safeVersion - The Safe core version to use for ABI and proxy code selection.
   * @param {bigint | number} [config.chainId] - Optional chain ID; used to guard against zkSync usage in this path.
   * @returns {string} The predicted Safe address (checksumed hex string).
   */
  static predictSafeAddress({
    factoryAddress,
    singletonAddress,
    safeAccountConfig,
    saltNonce,
    safeVersion,
    chainId
  }: {
    factoryAddress: string
    singletonAddress: string
    safeAccountConfig: SafeAccountConfig
    saltNonce: string
    safeVersion: string
    chainId?: bigint | number
  }): string {
    // 1. Encode initializer from SafeAccountConfig
    const initializer = encodeSetupCallDataSync(safeAccountConfig, safeVersion)

    // 2. Salt
    const initializerHash = keccak256(initializer as `0x${string}`)
    const salt = keccak256(concat([initializerHash, saltNonce as `0x${string}`]))

    // 3. Build initCode = proxyCreationCode ++ constructor(singleton)
    const proxyCreationCode = getProxyCreationCode(safeVersion, chainId)
    const singletonEncoded = toHex(singletonAddress, { size: 32 })
    const initCode = concat([proxyCreationCode as `0x${string}`, singletonEncoded])

    // 4. CREATE2 formula
    const hash = keccak256(
      concat(['0xff' as `0x${string}`, factoryAddress as `0x${string}`, salt, keccak256(initCode)])
    )

    return slice(hash, 12)
  }

  /**
   * Predicts the address of a Safe account using deployment data resolved by chain ID and Safe version.
   *
   * This convenience method fetches the canonical ProxyFactory and singleton addresses
   * from @safe-global/safe-deployments and delegates to predictSafeAddress.
   *
   * @param {Object} config - The prediction configuration.
   * @param {bigint | number} config.chainId - The chain ID.
   * @param {SafeAccountConfig} config.safeAccountConfig - The Safe account configuration used to encode the initializer.
   * @param {string} config.saltNonce - 0x-prefixed 32-byte salt used for CREATE2.
   * @param {string} config.safeVersion - The Safe core version to use for ABI and proxy code selection.
   * @returns {string} The predicted Safe address (checksumed hex string).
   * @throws {Error} If called for a zkSync chain. Use the zkSync-specific path for prediction.
   */
  static predictSafeAddressWithChainId({
    chainId,
    safeAccountConfig,
    saltNonce,
    safeVersion
  }: {
    chainId: bigint | number
    safeAccountConfig: SafeAccountConfig
    saltNonce: string
    safeVersion: string
  }): string {
    // zkSync guard – we will implement zkSync preimage in a separate step
    if (isZkSyncChain(chainId)) {
      throw new Error(
        'zkSync address prediction requires zkSync CREATE2 preimage. Use zkSync-specific path.'
      )
    }

    const addresses = getSafeContractAddresses(chainId, safeVersion)

    return Safe4337Pack.predictSafeAddress({
      factoryAddress: addresses.factory,
      singletonAddress: addresses.singleton,
      safeAccountConfig,
      saltNonce,
      safeVersion,
      chainId
    })
  }

  /**
   * Gets the default factory and singleton addresses for a given chain ID.
   *
   * This helper uses the default Safe version supported by the library (currently '1.4.1').
   *
   * @param {bigint | number} chainId - The chain ID.
   * @returns {{ factory: string; singleton: string }} Object containing factory and singleton addresses.
   * @throws {Error} If no default addresses are found for the chain ID.
   */
  static getDefaultAddresses(chainId: bigint | number): { factory: string; singleton: string } {
    return getSafeContractAddresses(chainId)
  }
}
