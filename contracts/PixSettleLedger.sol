// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Interface mínima de ERC-20. Na Arc, USDC é 0x3600000000000000000000000000000000000000
/// pela interface ERC-20 (6 casas). O gás nativo usa 18 casas; este contrato nunca usa msg.value.
interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @title PixSettleLedger
/// @notice Liquidação em USDC de pedidos pagos por Pix (simulado fora da cadeia), com as regras
/// de exceção do PixSettle aplicadas na própria cadeia:
///  - uma liquidação por pedido; repetir o mesmo settlementId não paga de novo (idempotente);
///  - caso de devolução aberto bloqueia a liquidação do pedido;
///  - devolução depois da liquidação vira exposição, que o lojista devolve à tesouraria;
///  - todo pagamento leva o digest de um recibo canônico (sha256 do JSON canônico, ver scripts/receipt.cjs);
///    o digest prova só que o recibo não mudou depois de registrado; o estado do Pix é informado pelo operador;
///  - a devolução de exposição vai sempre para a tesouraria que pagou aquele pedido, gravada na liquidação.
contract PixSettleLedger {
    enum State {
        None, // nunca liquidado, sem caso aberto
        Settled, // pago ao lojista
        RefundOpen, // devolução em análise antes de liquidar: liquidação bloqueada
        Exposure, // devolução depois de liquidar: lojista deve devolver o valor
        Closed // encerrado (devolvido antes de liquidar, ou exposição devolvida)
    }

    struct Order {
        State state;
        address merchant;
        uint64 settledAt;
        uint256 amount;
        bytes32 settlementId;
        bytes32 receiptDigest;
        address paidFrom; // tesouraria que pagou este pedido; destino fixo da devolução
    }

    IERC20Minimal public immutable usdc;
    address public owner;
    address public operator;
    address public treasury;

    mapping(address => bool) public merchants;
    mapping(bytes32 => Order) private _orders;
    mapping(bytes32 => bytes32) public orderOfSettlement;

    event OwnerChanged(address indexed owner);
    event OperatorChanged(address indexed operator);
    event TreasuryChanged(address indexed treasury);
    event MerchantSet(address indexed merchant, bool allowed);
    event Settled(
        bytes32 indexed orderRef,
        bytes32 indexed settlementId,
        address indexed merchant,
        uint256 amount,
        bytes32 receiptDigest,
        address paidFrom
    );
    event SettlementReplayed(bytes32 indexed orderRef, bytes32 indexed settlementId);
    event RefundCaseOpened(bytes32 indexed orderRef, bool afterSettlement);
    event RefundCaseClosed(bytes32 indexed orderRef, bool refunded);
    event ExposureReturned(bytes32 indexed orderRef, address indexed merchant, address indexed paidFrom, uint256 amount);

    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error ZeroValue();
    error UnknownMerchant(address merchant);
    error ReplayMismatch(bytes32 settlementId);
    error InvalidState(bytes32 orderRef, State state);
    error NotOrderMerchant(bytes32 orderRef);
    error TransferFailed();
    error WrongDecimals();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @param expectedDecimals 6 para a interface ERC-20 do USDC na Arc. É só uma checagem de sanidade:
    /// conta sem código ou casas diferentes revertem, mas decimals NÃO autentica o token (um token falso
    /// de 6 casas passa). A identidade do USDC é conferida fora do contrato, no preflight de deploy e demo
    /// (chainId, endereço oficial, código, decimals e ledger.usdc()); ver scripts/preflight.cjs.
    constructor(IERC20Minimal usdc_, address operator_, address treasury_, uint8 expectedDecimals) {
        if (address(usdc_) == address(0) || operator_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (usdc_.decimals() != expectedDecimals) revert WrongDecimals();
        usdc = usdc_;
        owner = msg.sender;
        operator = operator_;
        treasury = treasury_;
        emit OwnerChanged(msg.sender);
        emit OperatorChanged(operator_);
        emit TreasuryChanged(treasury_);
    }

    // ---------- administração ----------

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerChanged(next);
    }

    function setOperator(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        operator = next;
        emit OperatorChanged(next);
    }

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        treasury = next;
        emit TreasuryChanged(next);
    }

    function setMerchant(address merchant, bool allowed) external onlyOwner {
        if (merchant == address(0)) revert ZeroAddress();
        merchants[merchant] = allowed;
        emit MerchantSet(merchant, allowed);
    }

    // ---------- liquidação ----------

    /// @notice Paga o lojista com USDC da tesouraria (que deu approve a este contrato).
    /// @return fresh true se pagou agora; false se era repetição exata de uma liquidação já feita.
    function settle(bytes32 orderRef, bytes32 settlementId, address merchant, uint256 amount, bytes32 receiptDigest)
        external
        onlyOperator
        returns (bool fresh)
    {
        if (orderRef == bytes32(0) || settlementId == bytes32(0) || receiptDigest == bytes32(0) || amount == 0) {
            revert ZeroValue();
        }

        bytes32 known = orderOfSettlement[settlementId];
        if (known != bytes32(0)) {
            Order storage prev = _orders[known];
            if (
                known != orderRef || prev.merchant != merchant || prev.amount != amount
                    || prev.receiptDigest != receiptDigest
            ) revert ReplayMismatch(settlementId);
            emit SettlementReplayed(orderRef, settlementId);
            return false;
        }

        Order storage o = _orders[orderRef];
        if (o.state != State.None) revert InvalidState(orderRef, o.state);
        if (!merchants[merchant]) revert UnknownMerchant(merchant);

        o.state = State.Settled;
        o.merchant = merchant;
        o.amount = amount;
        o.settlementId = settlementId;
        o.receiptDigest = receiptDigest;
        o.settledAt = uint64(block.timestamp);
        o.paidFrom = treasury;
        orderOfSettlement[settlementId] = orderRef;

        emit Settled(orderRef, settlementId, merchant, amount, receiptDigest, treasury);
        _pull(treasury, merchant, amount);
        return true;
    }

    // ---------- exceções ----------

    /// @notice Abre caso de devolução. Antes da liquidação bloqueia o pagamento;
    /// depois dela, registra exposição a ser devolvida pelo lojista.
    function openRefundCase(bytes32 orderRef) external onlyOperator {
        if (orderRef == bytes32(0)) revert ZeroValue();
        Order storage o = _orders[orderRef];
        if (o.state == State.None) {
            o.state = State.RefundOpen;
            emit RefundCaseOpened(orderRef, false);
        } else if (o.state == State.Settled) {
            o.state = State.Exposure;
            emit RefundCaseOpened(orderRef, true);
        } else {
            revert InvalidState(orderRef, o.state);
        }
    }

    /// @notice Fecha um caso aberto antes da liquidação. refunded=false (reclamação improcedente)
    /// volta o pedido a liquidável; refunded=true encerra o pedido sem pagamento.
    function closeRefundCase(bytes32 orderRef, bool refunded) external onlyOperator {
        Order storage o = _orders[orderRef];
        if (o.state != State.RefundOpen) revert InvalidState(orderRef, o.state);
        o.state = refunded ? State.Closed : State.None;
        emit RefundCaseClosed(orderRef, refunded);
    }

    /// @notice Exposição improcedente depois da liquidação: volta a Settled sem movimentar dinheiro.
    function dismissExposure(bytes32 orderRef) external onlyOperator {
        Order storage o = _orders[orderRef];
        if (o.state != State.Exposure) revert InvalidState(orderRef, o.state);
        o.state = State.Settled;
        emit RefundCaseClosed(orderRef, false);
    }

    /// @notice O lojista devolve o valor liquidado de um pedido em exposição à tesouraria que o pagou
    /// (o.paidFrom), mesmo que a tesouraria atual tenha mudado depois.
    function returnExposure(bytes32 orderRef) external {
        Order storage o = _orders[orderRef];
        if (o.state != State.Exposure) revert InvalidState(orderRef, o.state);
        if (msg.sender != o.merchant) revert NotOrderMerchant(orderRef);
        o.state = State.Closed;
        emit ExposureReturned(orderRef, msg.sender, o.paidFrom, o.amount);
        emit RefundCaseClosed(orderRef, true);
        _pull(msg.sender, o.paidFrom, o.amount);
    }

    // ---------- leitura ----------

    function getOrder(bytes32 orderRef) external view returns (Order memory) {
        return _orders[orderRef];
    }

    function tokenDecimals() external view returns (uint8) {
        return usdc.decimals();
    }

    // ---------- interno ----------

    /// @dev Aceita token que devolve true ou nada; reverte em false ou erro.
    function _pull(address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            address(usdc).call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
